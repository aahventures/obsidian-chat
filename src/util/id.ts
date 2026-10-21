/** An id unique across devices and reloads: the time plus a random part, after `prefix`. */
export function uniqueId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
