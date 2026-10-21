import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";

/** Shared with the Models API call in settings.ts. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_API_URL = `${ANTHROPIC_API_BASE}/messages`;

type ThinkingMode = "adaptive" | "budget" | "none";

/**
 * How each Claude model takes thinking, by id prefix, longest match wins (as in
 * context-window.ts), so dated ids and point releases match their family.
 * Every model from 4.6 on takes `adaptive`, and most reject `budget_tokens`
 * with a 400 (Fable has thinking always on and rejects any other explicit
 * config); Opus 4.7/4.8 and the 4.6 models run without thinking unless it's
 * asked for. Older models only think with a fixed budget. Claude 3 models
 * before 3.7 have no thinking.
 */
const THINKING_MODES: Array<[prefix: string, mode: ThinkingMode]> = [
  ["claude-fable-5", "adaptive"],
  ["claude-mythos", "adaptive"],
  ["claude-opus-5", "adaptive"],
  ["claude-opus-4-8", "adaptive"],
  ["claude-opus-4-7", "adaptive"],
  ["claude-opus-4-6", "adaptive"],
  ["claude-opus-4", "budget"],
  ["claude-sonnet-5", "adaptive"],
  ["claude-sonnet-4-6", "adaptive"],
  ["claude-sonnet-4", "budget"],
  ["claude-haiku-5", "adaptive"],
  ["claude-haiku-4-5", "budget"],
  ["claude-3-7-sonnet", "budget"],
  ["claude-3", "none"],
];

/**
 * The `thinking` field for a model, or null to send none. A Claude model not
 * in the table is newer than it, so it gets `adaptive`; an id that isn't a
 * Claude one gets nothing rather than a config it may reject.
 */
export function thinkingConfigOf(model: string): Record<string, unknown> | null {
  let best: [string, ThinkingMode] | null = null;
  for (const entry of THINKING_MODES) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  const mode = best?.[1] ?? (model.startsWith("claude-") ? "adaptive" : "none");
  if (mode === "adaptive") return { type: "adaptive" };
  // Must stay below max_tokens.
  if (mode === "budget") return { type: "enabled", budget_tokens: 8192 };
  return null;
}

/**
 * Sends a message to the Anthropic Messages API via requestUrl().
 *
 * Anthropic format:
 * - System prompt is a top-level field, not a message
 * - Tools use `input_schema` (not `parameters`)
 * - Tool results are sent as user messages with type "tool_result"
 */
export async function sendAnthropicMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const model = settings.model || "claude-sonnet-4-6";
  const body: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    // System prompt as a content block with cache_control breakpoint.
    // Anthropic caches everything up to the breakpoint across requests.
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: withConversationCacheBreakpoint(messages.map(toAnthropicMessage)),
  };

  const thinking = thinkingConfigOf(model);
  if (thinking) body.thinking = thinking;

  if (tools.length > 0 || settings.enableWebSearch) {
    const apiTools: Record<string, unknown>[] = tools.map((t, i, arr) => {
      const tool: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      };
      // Place cache_control breakpoint on the last function tool
      // so the entire tools array prefix is cached
      if (i === arr.length - 1 && !settings.enableWebSearch) {
        tool.cache_control = { type: "ephemeral" };
      }
      return tool;
    });

    // Anthropic web search is a server-managed tool
    if (settings.enableWebSearch) {
      apiTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        cache_control: { type: "ephemeral" },
      });
    }

    body.tools = apiTools;
  }

  let response;
  try {
    response = await requestUrl({
      url: ANTHROPIC_API_URL,
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    // requestUrl throws on network errors; extract API details if available
    const err = e as { status?: number; json?: { error?: { message?: string } } };
    const apiMsg = err.json?.error?.message;
    if (apiMsg) {
      throw new Error(`Anthropic API error (${err.status}): ${apiMsg}`);
    }
    throw e;
  }

  if (response.status !== 200) {
    const errorText = typeof response.json?.error?.message === "string"
      ? response.json.error.message
      : `HTTP ${response.status}`;
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = response.json;

  return {
    content: (data.content as AnthropicContentBlock[])
      .map(fromAnthropicBlock)
      .filter((b): b is ContentBlock => b !== null),
    stopReason: data.stop_reason === "end_turn" ? "end_turn" : data.stop_reason,
    model: typeof data.model === "string" ? data.model : undefined,
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
          multiStep: (data.usage.server_tool_use?.web_search_requests ?? 0) > 0,
        }
      : undefined,
  };
}

// ─── Format Conversions ─────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "web_search_tool_result" | "server_tool_use" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  search_results?: Array<{ title: string; url: string; snippet: string }>;
}

/**
 * Put a cache breakpoint on the newest message, so each call reads the whole
 * conversation so far from cache instead of resending it at full price. Without
 * it only the system prompt and tools were cached, and every note a tool had
 * read was resent in full on every later call. The breakpoint moves forward
 * each call and the previous one stays a valid read point. With the system
 * prompt and the last tool that's 3 of the 4 breakpoints a request may have.
 * Below the model's minimum cacheable size it silently doesn't cache.
 */
function withConversationCacheBreakpoint(
  apiMessages: Record<string, unknown>[]
): Record<string, unknown>[] {
  const last = apiMessages[apiMessages.length - 1];
  if (!last) return apiMessages;
  const marker = { cache_control: { type: "ephemeral" } };

  let content: unknown;
  if (typeof last.content === "string") {
    if (!last.content) return apiMessages;
    content = [{ type: "text", text: last.content, ...marker }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = [...(last.content as Record<string, unknown>[])];
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...marker };
    content = blocks;
  } else {
    return apiMessages;
  }
  return [...apiMessages.slice(0, -1), { ...last, content }];
}

function toAnthropicMessage(msg: UnifiedMessage): Record<string, unknown> {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Content blocks (tool_use responses from assistant, tool_result from user)
  const blocks = msg.content.map((block) => {
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error || false,
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    return { type: "text", text: block.text };
  }).filter((b) => !(b.type === "text" && !b.text));

  return { role: msg.role, content: blocks };
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // Web search results are server-managed; render as text for the user
  if (block.type === "web_search_tool_result" && block.search_results) {
    const formatted = block.search_results
      .map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`)
      .join("\n\n");
    return { type: "text", text: formatted };
  }
  // Thinking and server_tool_use blocks are internal; don't surface to user
  if (block.type === "thinking" || block.type === "server_tool_use") {
    return null;
  }
  // Skip blocks with no text content (safety net)
  if (!block.text) {
    return null;
  }
  return { type: "text", text: block.text };
}
