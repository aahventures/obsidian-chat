import { App, Platform, TFile, TFolder, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";

/**
 * Skills: saved instructions for a kind of task, in Claude Code's format
 * (`<name>/SKILL.md` with `name` and `description` frontmatter, plus any
 * files it refers to). They come from three places, lowest first when two
 * share a name (compared without case):
 *
 * - the snapshot: `skills.json` in the plugin folder, which desktop writes
 *   from Claude Code's skills ("Sync Claude Code skills") and which syncs to
 *   other devices along with the plugin folder. This is how Claude Code's
 *   skills reach a phone. One file, replaced in one write: there's nothing in
 *   the vault to keep in step, rename or clean up.
 * - `~/.claude/skills` on desktop, including `synced/<account>/`, where Claude
 *   Code keeps the skills of a claude.ai account. Mobile has no home folder,
 *   so there this source is simply empty.
 * - your own skills, in a folder in the vault (Settings → Skills folder),
 *   on every platform.
 *
 * Skills are plugin-wide rather than per session, so they live here rather
 * than on each AgentLoop.
 */
export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  source: "vault" | "claude" | "snapshot";
  /** The skill's folder: a vault path, or an absolute path on disk. Empty for a snapshot. */
  dir: string;
  /** Every other file in the folder, relative to it, up to MAX_FILES. */
  files: string[];
  /** The folder had more than MAX_FILES other files; `files` stops there. */
  truncated: boolean;
  /** From the snapshot: files of the original that it doesn't carry (scripts, binaries, big files). */
  leftOut: string[];
  /** Ships scripts, which can't run here. Its instructions still can be followed. */
  hasScripts: boolean;
  /** From the snapshot: the text of its files, keyed like `files`. */
  contents?: Record<string, string>;
}

/** A skill folder holding more files than this is cut short rather than walked whole. */
const MAX_FILES = 100;
const SCRIPT_FILE = /(^|\/)scripts\/|\.(py|sh|bash|js|mjs|ts|rb|pl)$/i;
/** Reference files the snapshot carries: text, and not too big. */
const TEXT_FILE = /\.(md|txt|json|csv|tsv|ya?ml|toml|ini|xml|html?|css|svg|tex|rst)$/i;
const MAX_SNAPSHOT_FILE = 200 * 1024;
const MAX_SNAPSHOT_TOTAL = 5 * 1024 * 1024;

let skills: Skill[] = [];
/** Loads can overlap (a setting typed in, a file synced in); the newest wins. */
let loadGeneration = 0;

/** Every loaded skill, sorted by name so the system prompt built from it is stable. */
export function getSkills(): Skill[] {
  return skills;
}

export async function loadSkills(
  app: App,
  vaultFolder: string,
  useClaude: boolean,
  snapshotPath: string
): Promise<void> {
  const generation = ++loadGeneration;
  const snapshot = await readSnapshot(app, snapshotPath);
  const own = await readVaultSkills(app, vaultFolder);
  // Lowest first; a later source replaces a same-named skill from an earlier one.
  const found = new Map<string, Skill>();
  for (const s of snapshot?.skills ?? []) found.set(s.name.toLowerCase(), fromSnapshot(s));
  if (useClaude) for (const s of readClaudeSkills()) found.set(s.name.toLowerCase(), s);
  for (const s of own) found.set(s.name.toLowerCase(), s);
  if (generation !== loadGeneration) return;
  skills = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function clearSkills(): void {
  loadGeneration++;
  skills = [];
}

/** A skill by exact name, else by a prefix only one name has: `/write` → write-in-my-voice. */
export function resolveSkill(query: string): Skill | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = skills.find((s) => s.name.toLowerCase() === q);
  if (exact) return exact;
  const hits = skills.filter((s) => s.name.toLowerCase().startsWith(q));
  return hits.length === 1 ? hits[0] : undefined;
}

/** Read one of a skill's own files. Only files listed in `files` can be read. */
export async function readSkillFile(app: App, skill: Skill, file: string): Promise<string | null> {
  const rel = file.replace(/^\.?\//, "");
  if (!skill.files.includes(rel)) return null;
  if (skill.source === "snapshot") return skill.contents?.[rel] ?? null;
  if (skill.source === "vault") return app.vault.adapter.read(`${skill.dir}/${rel}`);
  const node = nodeModules();
  return node ? node.fs.readFileSync(node.path.join(skill.dir, rel), "utf8") : null;
}

/** The vault folder setting as a vault path, or "" for none. */
export function skillsFolderPath(folder: string): string {
  const trimmed = folder.trim();
  return trimmed ? normalizePath(trimmed) : "";
}

/** Whether a vault path is inside the skills folder. */
export function inSkillsFolder(path: string, folderSetting: string): boolean {
  const folder = skillsFolderPath(folderSetting);
  return !!folder && (path === folder || path.startsWith(folder + "/"));
}

/**
 * Folders whose files the [[ menu leaves out, each ending in "/": every folder
 * in the skills folder holding a SKILL.md (any case, as the loader finds it on
 * macOS and Windows). Read off the vault's folder tree rather than the loaded
 * skills, so a skill that didn't load (bad frontmatter, a name clash, a reload
 * still pending) is hidden too. Only the skills folder's own children are
 * looked at, not the whole vault. Other notes in the skills folder stay.
 */
export function hiddenSkillDirs(app: App, folderSetting: string): string[] {
  const folder = skillsFolderPath(folderSetting);
  const root = folder ? app.vault.getFolderByPath(folder) : null;
  if (!root) return [];
  const dirs: string[] = [];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    if (child.children.some((f) => f instanceof TFile && f.name.toLowerCase() === "skill.md")) dirs.push(child.path + "/");
  }
  return dirs;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseSkill(
  raw: string,
  folderName: string,
  source: Skill["source"],
  dir: string,
  listed: string[]
): Skill | null {
  const fm = getFrontMatterInfo(raw);
  if (!fm.exists) return null;
  let meta: Record<string, unknown>;
  try {
    meta = parseYaml(fm.frontmatter) ?? {};
  } catch {
    return null;
  }
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  if (!description) return null;
  const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : folderName;
  // Listings run one past the cap, so going over it shows.
  const files = listed.slice(0, MAX_FILES);
  return {
    name,
    description: description.replace(/\s+/g, " "),
    body: raw.slice(fm.contentStart).trim(),
    source,
    dir,
    files,
    truncated: listed.length > MAX_FILES,
    leftOut: [],
    hasScripts: files.some((f) => SCRIPT_FILE.test(f)),
  };
}

// ─── Your own skills, in the vault ──────────────────────────────────────────

/**
 * `<folder>/<name>/SKILL.md`. Read through the adapter rather than the vault
 * index, so a folder Obsidian doesn't index (a dot-folder) still works.
 */
async function readVaultSkills(app: App, folderSetting: string): Promise<Skill[]> {
  const folder = skillsFolderPath(folderSetting);
  if (!folder) return [];
  const adapter = app.vault.adapter;
  const out: Skill[] = [];
  let dirs: string[];
  try {
    if (!(await adapter.exists(folder))) return [];
    dirs = (await adapter.list(folder)).folders;
  } catch (e) {
    console.warn("Obsidian Chat: couldn't read skills folder", e);
    return [];
  }
  for (const dir of dirs) {
    try {
      const skillFile = `${dir}/SKILL.md`;
      if (!(await adapter.exists(skillFile))) continue;
      const files = (await listVaultFiles(app, dir)).filter((f) => f !== "SKILL.md");
      const skill = parseSkill(await adapter.read(skillFile), dir.split("/").pop() ?? dir, "vault", dir, files);
      if (skill) out.push(skill);
    } catch {
      // One unreadable skill shouldn't hide the rest.
    }
  }
  return out;
}

/** Up to MAX_FILES + 2 files (SKILL.md, and one over the cap so it shows), relative to `dir`. */
async function listVaultFiles(app: App, dir: string): Promise<string[]> {
  const max = MAX_FILES + 2;
  const out: string[] = [];
  const queue = [dir];
  while (queue.length > 0 && out.length < max) {
    const listing = await app.vault.adapter.list(queue.shift()!);
    for (const f of listing.files) out.push(f.slice(dir.length + 1));
    queue.push(...listing.folders);
  }
  return out.slice(0, max);
}

// ─── ~/.claude/skills (desktop only) ────────────────────────────────────────

/**
 * The few Node calls used here. Declared rather than typed from @types/node,
 * which the build leaves out because most of the plugin must run on mobile.
 */
interface NodeModules {
  fs: {
    existsSync(p: string): boolean;
    statSync(p: string): { isDirectory(): boolean; size: number };
    readdirSync(p: string): string[];
    readFileSync(p: string, encoding: "utf8"): string;
  };
  path: { join(...parts: string[]): string };
  os: { homedir(): string };
}

/**
 * Node's modules, on desktop only. Required at call time rather than imported,
 * so the same bundle still loads on mobile, where they don't exist.
 */
function nodeModules(): NodeModules | null {
  if (!Platform.isDesktopApp) return null;
  try {
    const req = (window as unknown as { require: (id: string) => unknown }).require;
    return {
      fs: req("fs") as NodeModules["fs"],
      path: req("path") as NodeModules["path"],
      os: req("os") as NodeModules["os"],
    };
  } catch {
    return null;
  }
}

/** Claude Code's skills folder, or null where there isn't one (mobile, no Claude Code). */
export function claudeSkillsDir(): string | null {
  const node = nodeModules();
  if (!node) return null;
  const dir = node.path.join(node.os.homedir(), ".claude", "skills");
  return node.fs.existsSync(dir) ? dir : null;
}

/**
 * `~/.claude/skills/<name>/SKILL.md`, and `synced/<account>/<name>/SKILL.md`
 * for skills Claude Code downloads from claude.ai. Never throws: a broken or
 * missing folder means no skills from it.
 */
export function readClaudeSkills(): Skill[] {
  return scanClaudeSkills().skills;
}

interface ClaudeScan {
  skills: Skill[];
  /** Folders with a SKILL.md that isn't a skill (no frontmatter or description): left out for good. */
  notSkills: string[];
  /** Folders that couldn't be read just now; their skills may only be missing for a moment. */
  unreadable: string[];
}

function scanClaudeSkills(): ClaudeScan {
  const result: ClaudeScan = { skills: [], notSkills: [], unreadable: [] };
  const node = nodeModules();
  const root = claudeSkillsDir();
  if (!node || !root) return result;
  const { fs, path } = node;

  const readdir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      console.warn(`Obsidian Chat: couldn't read ${dir}`, e);
      result.unreadable.push(dir);
      return [];
    }
  };

  const parents = [root];
  const synced = path.join(root, "synced");
  if (isDir(fs, synced)) {
    for (const account of readdir(synced)) {
      const p = path.join(synced, account);
      if (isDir(fs, p)) parents.push(p);
    }
  }
  for (const parent of parents) {
    for (const name of readdir(parent)) {
      const dir = path.join(parent, name);
      const skillFile = path.join(dir, "SKILL.md");
      // isDir follows symlinks, so a skill linked in from the vault counts.
      if (!isDir(fs, dir) || !fs.existsSync(skillFile)) continue;
      try {
        const files = listDiskFiles(node, dir).filter((f) => f !== "SKILL.md");
        const skill = parseSkill(fs.readFileSync(skillFile, "utf8"), name, "claude", dir, files);
        if (skill) result.skills.push(skill);
        else result.notSkills.push(name);
      } catch {
        // One unreadable skill shouldn't hide the rest.
        result.unreadable.push(dir);
      }
    }
  }
  return result;
}

function isDir(fs: NodeModules["fs"], p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Up to MAX_FILES + 2 files (SKILL.md, and one over the cap so it shows), relative to `dir`. */
function listDiskFiles({ fs, path }: NodeModules, dir: string): string[] {
  const max = MAX_FILES + 2;
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < max) {
    const rel = queue.shift()!;
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDir(fs, path.join(dir, childRel))) queue.push(childRel);
      else out.push(childRel);
    }
  }
  return out.slice(0, max);
}

// ─── The snapshot ───────────────────────────────────────────────────────────

/** One skill as the snapshot stores it. */
interface SnapshotSkill {
  name: string;
  description: string;
  body: string;
  /** Text files it carries, by path relative to the skill's folder. */
  files: Record<string, string>;
  /** Files of the original it doesn't carry. */
  leftOut: string[];
  hasScripts: boolean;
}

interface Snapshot {
  version: 1;
  updatedAt: number;
  skills: SnapshotSkill[];
}

async function readSnapshot(app: App, path: string): Promise<Snapshot | null> {
  try {
    if (!(await app.vault.adapter.exists(path))) return null;
    const data = JSON.parse(await app.vault.adapter.read(path)) as Snapshot;
    return data?.version === 1 && Array.isArray(data.skills) ? data : null;
  } catch (e) {
    console.warn("Obsidian Chat: couldn't read the skills snapshot", e);
    return null;
  }
}

function fromSnapshot(s: SnapshotSkill): Skill {
  return {
    name: s.name,
    description: s.description,
    body: s.body,
    source: "snapshot",
    dir: "",
    files: Object.keys(s.files ?? {}),
    truncated: false,
    leftOut: s.leftOut ?? [],
    hasScripts: !!s.hasScripts,
    contents: s.files ?? {},
  };
}

export interface SnapshotResult {
  saved: string[];
  /** Saved skills whose scripts were left out, since scripts can't run here. */
  withoutScripts: string[];
  /** Folders in ~/.claude with a SKILL.md that isn't a skill (no description). */
  notSkills: string[];
  /** Something couldn't be read, so skills missing from this scan were kept from the last snapshot. */
  keptFromLast: string[];
}

/**
 * Save Claude Code's skills to the snapshot, for devices without Claude Code.
 * Each skill's instructions come along with its text files; scripts, binaries
 * and very big files are listed as left out instead. The file is written in
 * one go, and only when something changed. If part of ~/.claude couldn't be
 * read, skills it no longer finds are kept from the last snapshot rather than
 * dropped, since they may only be missing for a moment.
 */
export async function writeSnapshot(app: App, path: string): Promise<SnapshotResult> {
  const result: SnapshotResult = { saved: [], withoutScripts: [], notSkills: [], keptFromLast: [] };
  const node = nodeModules();
  if (!node) return result;
  const scan = scanClaudeSkills();
  result.notSkills = scan.notSkills;

  // One entry per name, as loadSkills keys them: a later skill (an account's
  // synced one) replaces a same-named one from the top of ~/.claude/skills.
  const byName = new Map<string, Skill>();
  for (const skill of scan.skills) byName.set(skill.name.toLowerCase(), skill);

  let total = 0;
  const entries = new Map<string, SnapshotSkill>();
  for (const [key, skill] of byName) {
    const files: Record<string, string> = {};
    const leftOut: string[] = [];
    for (const rel of skill.files) {
      const full = node.path.join(skill.dir, rel);
      try {
        const size = node.fs.statSync(full).size;
        if (!TEXT_FILE.test(rel) || SCRIPT_FILE.test(rel) || size > MAX_SNAPSHOT_FILE || total + size > MAX_SNAPSHOT_TOTAL) {
          leftOut.push(rel);
          continue;
        }
        files[rel] = node.fs.readFileSync(full, "utf8");
        total += size;
      } catch {
        leftOut.push(rel);
      }
    }
    if (skill.truncated) leftOut.push(`(more files past the first ${MAX_FILES})`);
    entries.set(key, {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      files,
      leftOut,
      hasScripts: skill.hasScripts,
    });
    result.saved.push(skill.name);
    if (skill.hasScripts) result.withoutScripts.push(skill.name);
  }

  const previous = await readSnapshot(app, path);
  if (scan.unreadable.length > 0) {
    for (const old of previous?.skills ?? []) {
      if (entries.has(old.name.toLowerCase())) continue;
      entries.set(old.name.toLowerCase(), old);
      result.keptFromLast.push(old.name);
    }
  }

  const sorted = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Unchanged skills mean an unchanged file, so sync has nothing to send.
  if (previous && JSON.stringify(previous.skills) === JSON.stringify(sorted)) return result;
  const snapshot: Snapshot = { version: 1, updatedAt: Date.now(), skills: sorted };
  await app.vault.adapter.write(path, JSON.stringify(snapshot));
  return result;
}

/** When the snapshot last changed on disk (written here or synced in), or 0 if there's none. */
export async function snapshotMtime(app: App, path: string): Promise<number> {
  try {
    return (await app.vault.adapter.stat(path))?.mtime ?? 0;
  } catch {
    return 0;
  }
}
