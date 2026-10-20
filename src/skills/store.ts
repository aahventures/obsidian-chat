import { App, TFile, TFolder, Vault, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";

/**
 * Skills: saved instructions for a kind of task, in Claude Code's format
 * (`<name>/SKILL.md` with `name` and `description` frontmatter, plus any
 * files it refers to), kept in a folder in the vault (Settings → Skills
 * folder). They sync like any note, so they work on every platform.
 *
 * Nothing is loaded or cached: each lookup walks the vault index and reads
 * each SKILL.md with cachedRead, which Obsidian keeps current. So a skill
 * added, edited or synced in counts on the next turn. (Not the metadata
 * cache, which can lag a file that just changed.)
 */
export interface Skill {
  name: string;
  description: string;
  folder: TFolder;
  /** Its SKILL.md, the name in any case. */
  file: TFile;
}

/** A folder with a SKILL.md that didn't load, and why. */
export interface SkippedSkill {
  folder: string;
  /** The name it would have had (its folder's, if the frontmatter couldn't be read). */
  name: string;
  reason: string;
}

/** Claude Code's own caps on a skill's name and description. */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/** A skill's files listed for the model. */
const MAX_FILES = 100;
/** Biggest file use_skill hands the model, SKILL.md included. */
const MAX_READ = 200 * 1024;
/** Characters of skills index a request carries: about 5,000 tokens. */
const MAX_SKILLS_INDEX = 20_000;
/** Skill files use_skill won't read: they'd reach the model as garbled text. */
const BINARY_FILE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|exe|dll|so|dylib|bin|wasm|class|pyc|o|a|mp3|m4a|wav|ogg|flac|mp4|mov|avi|mkv|webm|ttf|otf|woff2?|eot|docx?|xlsx?|pptx?|sqlite)$/i;

/** Names and paths are compared ignoring case and Unicode form (macOS can store é as e plus an accent). */
export function sameKey(s: string): string {
  return s.normalize("NFC").toLowerCase();
}

/** One order for names, the same on every device (localeCompare depends on the locale). */
function byName(a: string, b: string): number {
  const ka = sameKey(a);
  const kb = sameKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** A path as typed, as a vault path: backslashes made /, leading "./" or "/" dropped. "" when nothing's left. */
function cleanPath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, "/").replace(/^(\.?\/)+/, "");
  return trimmed ? normalizePath(trimmed) : "";
}

/** The folder setting as a vault path, or "" for none ("/" or "." would be the whole vault). */
export function skillsFolderPath(setting: string): string {
  if (typeof setting !== "string") return "";
  const path = cleanPath(setting);
  return path === "." ? "" : path;
}

/** The skills folder, matched ignoring case so `meta/skills` finds `Meta/Skills`. */
export function findSkillsFolder(app: App, setting: string): TFolder | null {
  const path = skillsFolderPath(setting);
  if (!path) return null;
  const key = sameKey(path);
  return app.vault.getFolderByPath(path) ?? app.vault.getAllFolders(false).find((f) => sameKey(f.path) === key) ?? null;
}

/** The folder's SKILL.md (any case), if it has one. */
function skillFileIn(folder: TFolder): TFile | null {
  for (const child of folder.children) {
    if (child instanceof TFile && sameKey(child.name) === "skill.md") return child;
  }
  return null;
}

/** One line, without runs of whitespace. */
function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Cut at a whole character, never inside an emoji. */
function cap(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : text;
}

/** A file's text, without a byte-order mark (Windows editors), which would hide frontmatter. */
async function readText(app: App, file: TFile): Promise<string> {
  return (await app.vault.cachedRead(file)).replace(/^\uFEFF/, "");
}

/** A SKILL.md's frontmatter, or why there's none to use. */
async function readFrontmatter(app: App, file: TFile): Promise<Record<string, unknown> | string> {
  if (file.stat.size > MAX_READ) return `it's over ${MAX_READ / 1024} KB`;
  let raw: string;
  try {
    raw = await readText(app, file);
  } catch (e) {
    return `it couldn't be read (${e instanceof Error ? e.message : String(e)})`;
  }
  const fm = getFrontMatterInfo(raw);
  if (!fm.exists) return "it has no frontmatter";
  try {
    const meta: unknown = parseYaml(fm.frontmatter);
    return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  } catch (e) {
    return `its frontmatter isn't valid YAML (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`;
  }
}

export interface SkillScan {
  /** The skills folder, or null when there's none. */
  root: TFolder | null;
  /** Sorted by name, so the system prompt built from them is stable. */
  skills: Skill[];
  skipped: SkippedSkill[];
}

/**
 * The skills directly in the skills folder (as in Claude Code), and those
 * that didn't load. A folder without a SKILL.md isn't a skill.
 */
export async function scanSkills(app: App, setting: string): Promise<SkillScan> {
  const root = findSkillsFolder(app, setting);
  const skills: Skill[] = [];
  const skipped: SkippedSkill[] = [];
  if (!root) return { root, skills, skipped };
  // In one order, so a name two folders share keeps the same one on every device.
  const found = root.children
    .filter((c): c is TFolder => c instanceof TFolder)
    .sort((a, b) => byName(a.name, b.name))
    .map((folder) => ({ folder, file: skillFileIn(folder) }))
    .filter((x): x is { folder: TFolder; file: TFile } => x.file !== null);
  const metas = await Promise.all(found.map(({ file }) => readFrontmatter(app, file)));
  const taken = new Map<string, Skill>();
  for (const [i, { folder, file }] of found.entries()) {
    const meta = metas[i];
    if (typeof meta === "string") {
      // Its name defaults to the folder's, so that's what the model would ask for.
      skipped.push({ folder: folder.path, name: folder.name, reason: meta });
      continue;
    }
    const description = cap(oneLine(meta.description), MAX_DESCRIPTION);
    const name = oneLine(meta.name) || folder.name;
    if (!description) {
      skipped.push({ folder: folder.path, name, reason: "it has no description in its frontmatter" });
      continue;
    }
    // Skipped rather than cut, like Claude Code: a cut name could collide with another.
    if (Array.from(name).length > MAX_NAME) {
      skipped.push({ folder: folder.path, name, reason: `its name is over ${MAX_NAME} characters` });
      continue;
    }
    const other = taken.get(sameKey(name));
    if (other) {
      skipped.push({ folder: folder.path, name, reason: `its name is the same as ${other.folder.path}'s` });
      continue;
    }
    const skill = { name, description, folder, file };
    taken.set(sameKey(name), skill);
    skills.push(skill);
  }
  skills.sort((a, b) => byName(a.name, b.name));
  return { root, skills, skipped };
}

export async function getSkills(app: App, setting: string): Promise<Skill[]> {
  return (await scanSkills(app, setting)).skills;
}

/** A skill by its name only: a second way to name one could pick the wrong skill. */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const q = sameKey(name.trim());
  return q ? skills.find((s) => sameKey(s.name) === q) : undefined;
}

/** Which files the [[ menu leaves out: those inside a folder in the skills folder that holds a SKILL.md. */
export function skillFileFilter(app: App, setting: string): (path: string) => boolean {
  const root = findSkillsFolder(app, setting);
  if (!root) return () => false;
  const dirs = new Set<string>();
  for (const child of root.children) {
    if (child instanceof TFolder && skillFileIn(child)) dirs.add(sameKey(child.name));
  }
  const prefix = root.path + "/";
  return (path) => {
    if (dirs.size === 0 || !path.startsWith(prefix)) return false;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    return slash > 0 && dirs.has(sameKey(rest.slice(0, slash)));
  };
}

/**
 * A line per skill, cut to a budget: every request carries the index (Claude
 * Code caps its own listing the same way). `more` gets how many didn't fit.
 */
export function skillsIndex(skills: Skill[], more: (left: number) => string): string {
  const lines: string[] = [];
  let size = 0;
  for (const s of skills) {
    const line = `- ${s.name}: ${s.description}`;
    if (size + line.length > MAX_SKILLS_INDEX) break;
    lines.push(line);
    size += line.length + 1;
  }
  if (lines.length < skills.length) lines.push(more(skills.length - lines.length));
  return lines.join("\n");
}

/** A skill's other files, relative to its folder, breadth first in one order; and whether there were more than listed. */
export function listSkill(skill: Skill): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const queue: TFolder[] = [skill.folder];
  while (queue.length > 0) {
    for (const child of [...queue.shift()!.children].sort((a, b) => byName(a.name, b.name))) {
      if (child instanceof TFolder) queue.push(child);
      else if (child !== skill.file) {
        if (files.length === MAX_FILES) return { files, truncated: true };
        files.push(relPath(skill, child));
      }
    }
  }
  return { files, truncated: false };
}

/** A file's path relative to its skill's folder, as the model sees it listed. */
export function relPath(skill: Skill, file: { path: string }): string {
  return file.path.slice(skill.folder.path.length + 1);
}

/** SKILL.md without its frontmatter. */
export async function readSkillBody(app: App, skill: Skill): Promise<string> {
  const raw = await readText(app, skill.file);
  return raw.slice(getFrontMatterInfo(raw).contentStart).trim();
}

/**
 * One of a skill's files, by the path use_skill listed (ignoring case), and
 * only from inside the skill's folder: a ".." never matches a real path.
 */
export async function readSkillFile(
  app: App,
  skill: Skill,
  file: string
): Promise<{ file: TFile; content: string } | { error: string }> {
  const want = sameKey(cleanPath(file));
  let found: TFile | undefined = want === "skill.md" ? skill.file : undefined;
  if (!found) {
    Vault.recurseChildren(skill.folder, (f) => {
      if (!found && f instanceof TFile && sameKey(relPath(skill, f)) === want) found = f;
    });
  }
  if (!found) return { error: `'${file}' isn't one of the files in skill '${skill.name}'.` };
  if (BINARY_FILE.test(found.name)) return { error: `'${file}' isn't a text file, so it can't be read here.` };
  if (found.stat.size > MAX_READ) return { error: `'${file}' is over ${MAX_READ / 1024} KB, too big to read here.` };
  return { file: found, content: await readText(app, found) };
}
