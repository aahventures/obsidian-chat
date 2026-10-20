/**
 * Obsidian's "Excluded files" setting (Settings → Files and links), which its
 * own link suggestions, Quick Switcher and search hide or demote.
 *
 * None of this is in obsidian.d.ts. The setting is `userIgnoreFilters` in
 * app.json: entries written `/.../` are regular expressions, any other entry is
 * a path prefix. Every undocumented call is guarded, so an Obsidian without
 * them simply excludes nothing.
 */

import type { App } from "obsidian";

/** The undocumented runtime calls, typed only as far as we use them. */
interface IgnoreApis {
  metadataCache: { isUserIgnored?: (path: string) => unknown };
  vault: { getConfig?: (key: string) => unknown };
}

const excludesNothing = (): boolean => false;

/**
 * A predicate saying whether a path is excluded. Build it once per search: it
 * reads the setting now, so edits apply on the next search without a reload.
 */
export function excludedFileFilter(app: App): (path: string) => boolean {
  const { metadataCache, vault } = app as unknown as IgnoreApis;

  // Obsidian's own check, so we match it exactly.
  const isUserIgnored = metadataCache.isUserIgnored;
  if (typeof isUserIgnored === "function") {
    return (path) => {
      try {
        return isUserIgnored.call(metadataCache, path) === true;
      } catch {
        return false;
      }
    };
  }

  let filters: unknown;
  try {
    filters = typeof vault.getConfig === "function" ? vault.getConfig.call(vault, "userIgnoreFilters") : undefined;
  } catch {
    return excludesNothing;
  }
  if (!Array.isArray(filters)) return excludesNothing;

  const prefixes: string[] = [];
  const patterns: RegExp[] = [];
  for (const filter of filters) {
    if (typeof filter !== "string" || !filter) continue;
    if (filter.length > 2 && filter.startsWith("/") && filter.endsWith("/")) {
      try {
        patterns.push(new RegExp(filter.slice(1, -1)));
      } catch {
        // An invalid pattern excludes nothing, as in Obsidian.
      }
    } else {
      prefixes.push(filter);
    }
  }
  if (!prefixes.length && !patterns.length) return excludesNothing;

  return (path) => prefixes.some((p) => path.startsWith(p)) || patterns.some((re) => re.test(path));
}
