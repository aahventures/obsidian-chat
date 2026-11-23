import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
  WebSearch,
  WebSource,
} from "../types";
import { resolveModel } from "../types";
import { compactionThreshold, summariesAsText } from "./compaction";

/** Shared with the Models API call in settings.ts. */
export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_API_URL = `${ANTHROPIC_API_BASE}/messages`;

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
  const model = resolveModel(settings);
  // Past the threshold the API summarizes everything before the newest turn
  // into a compaction block and answers from that. Models without it are
  // trimmed by the loop instead, and get any earlier summary as text.
  const compactAt = compactionThreshold("anthropic", model, settings.compactAt);
  const sent = compactAt === null ? summariesAsText(messages) : messages;
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
    messages: withConversationCacheBreakpoint(sent.map(toAnthropicMessage)),
  };
  const headers: Record<string, string> = {
    "x-api-key": settings.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  if (compactAt !== null) {
    headers["anthropic-beta"] = "compact-2026-01-12";
    body.context_management = {
      edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: compactAt } }],
    };
  }

  // Enable thinking based on model generation:
  // - Sonnet 4.6 / Opus 4.6: use adaptive thinking (auto-determines depth)
  // - Sonnet 4 / Opus 4 / older: use manual thinking with budget
  const is46Model = model.includes("4-6") || model.includes("4.6");
  const supportsThinking = model.includes("claude-sonnet-4") || model.includes("claude-opus") || model.includes("claude-sonnet-3-7");

  if (is46Model) {
    // Adaptive: Claude decides when/how much to think per request
    body.thinking = { type: "adaptive" };
  } else if (supportsThinking) {
    // Manual: fixed budget for older models
    body.thinking = { type: "enabled", budget_tokens: 8192 };
  }

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
      headers,
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
  const blocks = data.content as AnthropicContentBlock[];

  return {
    content: blocks
      .map(fromAnthropicBlock)
      .filter((b): b is ContentBlock => b !== null),
    searches: searchesOf(blocks),
    sources: citedSources(blocks),
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
  type: "text" | "tool_use" | "web_search_tool_result" | "server_tool_use" | "thinking" | "compaction";
  text?: string;
  /**
   * A compaction block's summary; a web_search_tool_result's results (a list),
   * or its error (an object).
   */
  content?: string | null | AnthropicSearchResult[] | { type?: string; error_code?: string };
  /** On a web_search_tool_result: the server_tool_use it answers. */
  tool_use_id?: string;
  /** On a text block: where its claims come from. */
  citations?: Array<{ type?: string; url?: string; title?: string | null }> | null;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicSearchResult {
  type?: string;
  url?: string;
  title?: string;
}

/**
 * The searches the response ran, each with what it searched for (from its
 * server_tool_use) and what came back. Shown as rows, so the user can see
 * whether a search really happened. Not kept in the history: the model's
 * reply carries what it took from them, as before.
 */
function searchesOf(blocks: AnthropicContentBlock[]): WebSearch[] {
  const queries = new Map<string, string>();
  for (const b of blocks) {
    if (b.type === "server_tool_use" && b.name === "web_search" && b.id) {
      const q = b.input?.query;
      queries.set(b.id, typeof q === "string" ? q : "");
    }
  }
  const searches: WebSearch[] = [];
  for (const b of blocks) {
    if (b.type !== "web_search_tool_result") continue;
    const query = queries.get(b.tool_use_id ?? "") ?? "";
    // A list on success; an object with an error_code on failure (still HTTP 200).
    if (Array.isArray(b.content)) {
      searches.push({
        query,
        results: b.content
          .filter((r) => typeof r.url === "string" && r.url)
          .map((r) => ({ title: r.title || r.url!, url: r.url! })),
      });
    } else {
      const code = b.content && typeof b.content === "object" ? b.content.error_code : undefined;
      searches.push({ query, results: [], error: code || "unknown_error" });
    }
  }
  return searches;
}

/** The pages the text cites, once each, in the order first cited. */
function citedSources(blocks: AnthropicContentBlock[]): WebSource[] {
  const seen = new Map<string, WebSource>();
  for (const b of blocks) {
    if (b.type !== "text" || !b.citations) continue;
    for (const c of b.citations) {
      if (c.type !== "web_search_result_location" || !c.url || seen.has(c.url)) continue;
      seen.set(c.url, { title: c.title || c.url, url: c.url });
    }
  }
  return [...seen.values()];
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
    // Sent back as is: the API drops everything before it.
    if (block.type === "compaction") {
      return { type: "compaction", content: block.content };
    }
    return { type: "text", text: block.text };
  }).filter((b) => !(b.type === "text" && !b.text));

  return { role: msg.role, content: blocks };
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  if (block.type === "compaction") {
    return typeof block.content === "string" ? { type: "compaction", content: block.content } : null;
  }
  // Server-side search: reported separately (searchesOf), not part of the history.
  if (
    block.type === "web_search_tool_result" ||
    block.type === "server_tool_use" ||
    block.type === "thinking"
  ) {
    return null;
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // Skip blocks with no text content (safety net)
  if (!block.text) {
    return null;
  }
  return { type: "text", text: block.text };
}
