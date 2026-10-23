import type { Provider, UnifiedMessage, ContentBlock } from "../types";
import { contextWindowOf } from "./context-window";

/**
 * Claude models with server-side compaction (`compact_20260112`), by id
 * prefix. Others get the beta request rejected, so they keep the local trim.
 */
const CLAUDE_COMPACTION = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5",
];

/** Anthropic's lowest trigger. */
const MIN_COMPACT_AT = 50_000;

/**
 * Whether the provider summarizes this model's older context itself once it
 * reaches the threshold: Anthropic, for the models above. Not OpenAI yet:
 * which of its models take `context_management` and what their input limits
 * are isn't verified, and a parameter a model rejects, or a threshold past its
 * limit, would break the chat. Custom providers have no such thing.
 */
export function compactsOnServer(provider: Provider, model: string): boolean {
  return provider === "anthropic" && CLAUDE_COMPACTION.some((p) => model.startsWith(p));
}

/**
 * Whether the summary comes back to the plugin, so compaction also bounds the
 * local history. Anthropic's does; a provider whose summary stayed on its side
 * would still need the local trim.
 */
export function returnsSummary(provider: Provider, model: string): boolean {
  return provider === "anthropic" && compactsOnServer(provider, model);
}

/**
 * The input size at which a request to this model compacts, or null if it
 * doesn't. The setting, kept inside the model's limit and Anthropic's minimum.
 */
export function compactionThreshold(provider: Provider, model: string, compactAt: number): number | null {
  if (!compactsOnServer(provider, model)) return null;
  const limit = contextWindowOf(provider, model);
  return Math.max(MIN_COMPACT_AT, Math.min(compactAt, limit ?? Infinity));
}

/** What the context meter measures a chat against. */
export interface ContextBudget {
  /** What the ring fills toward: where it compacts, or else the model's limit. */
  limit: number | null;
  /** `limit` is where the provider compacts, not the model's limit. */
  compacts: boolean;
  /** The model's own input limit, when known. */
  modelLimit: number | null;
}

export function contextBudget(provider: Provider, model: string, compactAt: number): ContextBudget {
  const modelLimit = contextWindowOf(provider, model);
  const threshold = compactionThreshold(provider, model, compactAt);
  return { limit: threshold ?? modelLimit, compacts: threshold !== null, modelLimit };
}

/** The message a compaction block opens, if any: Anthropic's summary of everything before it. */
export function isSummary(message: UnifiedMessage | undefined): boolean {
  return Array.isArray(message?.content) && message.content[0]?.type === "compaction";
}

/**
 * The history with each compaction block turned into a user message carrying
 * the summary as text, for a request that can't send the block itself: another
 * provider, or a Claude model without compaction. The rest of that message
 * keeps its role, so turns still alternate.
 */
export function summariesAsText(messages: UnifiedMessage[]): UnifiedMessage[] {
  if (!messages.some(isSummary)) return messages;
  return messages.flatMap((message) => {
    if (!isSummary(message)) return [message];
    const [summary, ...rest] = message.content as ContentBlock[];
    const text = `[Summary of the conversation so far, written when it grew long]\n\n${summary.content ?? ""}`;
    const out: UnifiedMessage[] = [{ role: "user", content: [{ type: "text", text }] }];
    if (rest.length > 0) out.push({ role: message.role, content: rest });
    return out;
  });
}
