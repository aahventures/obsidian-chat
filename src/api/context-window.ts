import type { Provider } from "../types";

/**
 * Input limits of Claude models by id prefix, longest match wins, so dated
 * ids ("claude-haiku-4-5-20251001") and point releases ("claude-opus-5-5")
 * match their family. Exact figures from the settings tab's model list take
 * precedence. A model not covered here shows its size without a percentage
 * until the model list is refreshed.
 */
const CLAUDE_LIMITS: Array<[prefix: string, limit: number]> = [
  ["claude-fable-5", 1_000_000],
  ["claude-mythos-5", 1_000_000],
  ["claude-opus-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-5", 1_000_000],
  ["claude-haiku-4-5", 200_000],
  ["claude-3", 200_000],
];

/** Limits reported by the Models API, by provider and model. */
const reported = new Map<string, number>();
const listeners = new Set<() => void>();

const keyOf = (provider: Provider, model: string) => `${provider}:${model}`;

/**
 * A model's input limit in tokens, or null when it isn't known. Only Claude
 * models have one: OpenAI's Models API doesn't report a limit and published
 * figures vary by source, so OpenAI and custom models get none rather than a
 * guessed one.
 */
export function contextWindowOf(provider: Provider, model: string): number | null {
  const exact = reported.get(keyOf(provider, model));
  if (exact) return exact;
  if (provider !== "anthropic") return null;
  let best: [string, number] | null = null;
  for (const entry of CLAUDE_LIMITS) {
    if (model.startsWith(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1] ?? null;
}

/** Call `listener` whenever a reported limit changes. Returns an unsubscribe function. */
export function onContextWindowsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record limits from the settings tab's model list. Listeners hear once. */
export function rememberContextWindows(
  provider: Provider,
  entries: Array<{ model: string; limit: unknown }>
): void {
  let changed = false;
  for (const { model, limit } of entries) {
    if (typeof limit !== "number" || limit <= 0) continue;
    const key = keyOf(provider, model);
    if (reported.get(key) === limit) continue;
    reported.set(key, limit);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}
