/**
 * Split cached input out of an input count that includes it (as OpenAI-style
 * APIs report it) to match UnifiedResponse, where inputTokens is the uncached
 * part. A cached count the server didn't report stays undefined, which the
 * context meter shows differently from none; one larger than the total is
 * capped so the parts still add up.
 */
export function splitCachedInput(
  total: number | undefined,
  reported: unknown
): { inputTokens: number; cacheReadTokens?: number } {
  const all = total || 0;
  if (typeof reported !== "number") return { inputTokens: all };
  const cached = Math.min(Math.max(reported, 0), all);
  return { inputTokens: all - cached, cacheReadTokens: cached };
}
