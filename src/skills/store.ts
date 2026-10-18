import { App, Platform, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";

/**
 * Skills: saved instructions for a kind of task, in Claude Code's format
 * (`<name>/SKILL.md` with `name` and `description` frontmatter, plus any
 * files it refers to). They come from two places:
 *
 * - a folder in the vault (Settings → Skills folder), on every platform. This
 *   is how skills reach mobile: the folder syncs like any other note.
 * - `~/.claude/skills` on desktop, including `synced/<account>/`, where Claude
 *   Code keeps the skills of a claude.ai account. Mobile has no home folder,
 *   so there this source is simply empty.
 *
 * Copies of Claude Code's skills, for phones, go in a folder of their own in
 * the skills folder (`Claude Code/`). The plugin owns it: each copy rebuilds
 * it, and nothing else in the skills folder is ever written. When names clash,
 * the user's own vault skills win, then the live ~/.claude ones, then copies,
 * so a copy only stands in where Claude Code isn't there.
 *
 * Skills are plugin-wide rather than per session, so they live here rather
 * than on each AgentLoop.
 */
export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** Your own skill in the vault, Claude Code's on disk, or a copy of one in the vault. */
  source: "vault" | "claude" | "copy";
  /** The skill's folder: a vault path, or an absolute path on disk. */
  dir: string;
  /** Every other file in the folder, relative to it. */
  files: string[];
  /** On a copy: files of the original that weren't copied (scripts, binaries). */
  leftOut: string[];
  /** Ships scripts, which can't run here. Its instructions still can be followed. */
  hasScripts: boolean;
}

/** The folder in the skills folder that holds copies of Claude Code's skills. */
export const COPIES_FOLDER = "Claude Code";
/** Frontmatter key a copy's SKILL.md records its left-out files under. */
const LEFT_OUT_KEY = "obsidian-chat-left-out";

/** A skill folder holding more than this is cut short rather than walked whole. */
const MAX_FILES = 100;
const SCRIPT_FILE = /(^|\/)scripts\/|\.(py|sh|bash|js|mjs|ts|rb|pl)$/i;
/** What a copy carries: instructions and the text files they refer to. */
const TEXT_FILE = /\.(md|txt|json|csv|tsv|ya?ml|toml|ini|xml|html?|css|svg|tex|rst)$/i;

let skills: Skill[] = [];
/** Loads can overlap (a setting typed in, a file synced in); the newest wins. */
let loadGeneration = 0;

/** Every loaded skill, sorted by name so the system prompt built from it is stable. */
export function getSkills(): Skill[] {
  return skills;
}

export async function loadSkills(app: App, vaultFolder: string, useClaude: boolean): Promise<void> {
  const generation = ++loadGeneration;
  const { own, copies } = await readVaultSkills(app, vaultFolder);
  // Lowest first; a later source replaces a same-named skill from an earlier one.
  const found = new Map<string, Skill>();
  for (const s of copies) found.set(s.name.toLowerCase(), s);
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
  if (skill.source !== "claude") return app.vault.adapter.read(`${skill.dir}/${rel}`);
  const node = nodeModules();
  return node ? node.fs.readFileSync(node.path.join(skill.dir, rel), "utf8") : null;
}

/** The vault folder setting as a vault path, or "" for none. */
export function skillsFolderPath(folder: string): string {
  const trimmed = folder.trim();
  return trimmed ? normalizePath(trimmed) : "";
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseSkill(
  raw: string,
  folderName: string,
  source: Skill["source"],
  dir: string,
  files: string[]
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
  const leftOut = Array.isArray(meta[LEFT_OUT_KEY])
    ? (meta[LEFT_OUT_KEY] as unknown[]).filter((f): f is string => typeof f === "string")
    : [];
  return {
    name,
    description: description.replace(/\s+/g, " "),
    body: raw.slice(fm.contentStart).trim(),
    source,
    dir,
    files,
    leftOut,
    hasScripts: files.some((f) => SCRIPT_FILE.test(f)) || leftOut.some((f) => SCRIPT_FILE.test(f)),
  };
}

// ─── Vault folder ───────────────────────────────────────────────────────────

/**
 * `<folder>/<name>/SKILL.md` (your own) and `<folder>/Claude Code/<name>/SKILL.md`
 * (copies). Read through the adapter rather than the vault index, so a folder
 * Obsidian doesn't index (a dot-folder) still works.
 */
async function readVaultSkills(app: App, folderSetting: string): Promise<{ own: Skill[]; copies: Skill[] }> {
  const folder = skillsFolderPath(folderSetting);
  const result = { own: [] as Skill[], copies: [] as Skill[] };
  if (!folder) return result;
  const copiesDir = `${folder}/${COPIES_FOLDER}`;
  try {
    if (!(await app.vault.adapter.exists(folder))) return result;
    result.own = await readSkillDirs(app, folder, "vault", copiesDir);
    if (await app.vault.adapter.exists(copiesDir)) result.copies = await readSkillDirs(app, copiesDir, "copy");
  } catch (e) {
    console.warn("Obsidian Chat: couldn't read skills folder", e);
  }
  return result;
}

async function readSkillDirs(app: App, parent: string, source: Skill["source"], skip?: string): Promise<Skill[]> {
  const adapter = app.vault.adapter;
  const out: Skill[] = [];
  for (const dir of (await adapter.list(parent)).folders) {
    if (dir === skip) continue;
    const skillFile = `${dir}/SKILL.md`;
    if (!(await adapter.exists(skillFile))) continue;
    try {
      const files = (await listVaultFiles(app, dir)).filter((f) => f !== "SKILL.md");
      const skill = parseSkill(await adapter.read(skillFile), dir.split("/").pop() ?? dir, source, dir, files);
      if (skill) out.push(skill);
    } catch {
      // One unreadable skill shouldn't hide the rest.
    }
  }
  return out;
}

async function listVaultFiles(app: App, dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [dir];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const listing = await app.vault.adapter.list(queue.shift()!);
    for (const f of listing.files) out.push(f.slice(dir.length + 1));
    queue.push(...listing.folders);
  }
  return out.slice(0, MAX_FILES);
}

// ─── ~/.claude/skills (desktop only) ────────────────────────────────────────

/**
 * The few Node calls used here. Declared rather than typed from @types/node,
 * which the build leaves out because most of the plugin must run on mobile.
 */
interface NodeModules {
  fs: {
    existsSync(p: string): boolean;
    statSync(p: string): { isDirectory(): boolean };
    readdirSync(p: string): string[];
    readFileSync(p: string, encoding: "utf8"): string;
    realpathSync(p: string): string;
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
  const node = nodeModules();
  const root = claudeSkillsDir();
  if (!node || !root) return [];
  const { fs, path } = node;

  const out: Skill[] = [];
  try {
    const parents = [root];
    const synced = path.join(root, "synced");
    if (isDir(fs, synced)) {
      for (const account of fs.readdirSync(synced)) {
        const p = path.join(synced, account);
        if (isDir(fs, p)) parents.push(p);
      }
    }
    for (const parent of parents) {
      for (const name of fs.readdirSync(parent)) {
        const dir = path.join(parent, name);
        const skillFile = path.join(dir, "SKILL.md");
        // isDir follows symlinks, so a skill linked in from the vault counts.
        if (!isDir(fs, dir) || !fs.existsSync(skillFile)) continue;
        try {
          const files = listDiskFiles(node, dir).filter((f) => f !== "SKILL.md");
          const skill = parseSkill(fs.readFileSync(skillFile, "utf8"), name, "claude", dir, files);
          if (skill) out.push(skill);
        } catch {
          // One unreadable skill shouldn't hide the rest.
        }
      }
    }
  } catch (e) {
    console.warn("Obsidian Chat: couldn't read ~/.claude/skills", e);
  }
  return out;
}

function isDir(fs: NodeModules["fs"], p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDiskFiles({ fs, path }: NodeModules, dir: string): string[] {
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < MAX_FILES) {
    const rel = queue.shift()!;
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (isDir(fs, path.join(dir, childRel))) queue.push(childRel);
      else out.push(childRel);
    }
  }
  return out.slice(0, MAX_FILES);
}

export interface CopyResult {
  /** Where the copies went. */
  folder: string;
  copied: string[];
  /** Copied skills whose scripts were left out, since scripts can't run here. */
  withoutScripts: string[];
  /** Skills whose real folder is in the skills folder already (symlinked into ~/.claude). */
  alreadyThere: string[];
}

/**
 * Copy Claude Code's skills into `<skills folder>/Claude Code/`, so devices
 * without Claude Code (phones) get them through sync. That folder is rebuilt
 * from scratch each time, so copies never go stale and nothing outside it is
 * touched. Each skill's text files come across; scripts and binaries don't,
 * since scripts can't run here, and the copy's SKILL.md lists what was left out.
 */
export async function copyClaudeSkillsToVault(app: App, folderSetting: string): Promise<CopyResult> {
  const folder = skillsFolderPath(folderSetting);
  const copiesDir = `${folder}/${COPIES_FOLDER}`;
  const result: CopyResult = { folder: copiesDir, copied: [], withoutScripts: [], alreadyThere: [] };
  const node = nodeModules();
  if (!node || !folder) return result;
  const adapter = app.vault.adapter;
  const base = "getBasePath" in adapter && typeof adapter.getBasePath === "function"
    ? (adapter.getBasePath() as string)
    : null;
  // One copy per name, as loadSkills keys them: a later skill (an account's
  // synced one) replaces a same-named one from the top of ~/.claude/skills.
  const byName = new Map<string, Skill>();
  for (const skill of readClaudeSkills()) byName.set(skill.name.toLowerCase(), skill);

  if (await adapter.exists(copiesDir)) await adapter.rmdir(copiesDir, true);
  await mkdirs(app, copiesDir);
  // Resolved once the folder exists, so both sides of the comparison are real paths.
  const skillsRoot = base ? comparablePath(realpath(node, node.path.join(base, folder))) : null;

  for (const skill of byName.values()) {
    // Linked in from the skills folder: it's one of your own, loaded from there.
    const real = comparablePath(realpath(node, skill.dir));
    if (skillsRoot && real.startsWith(skillsRoot + "/")) {
      result.alreadyThere.push(skill.name);
      continue;
    }
    const target = `${copiesDir}/${skill.name.replace(/[\\/:*?"<>|]/g, "-")}`;
    const kept = skill.files.filter((f) => TEXT_FILE.test(f) && !SCRIPT_FILE.test(f));
    const leftOut = skill.files.filter((f) => !kept.includes(f));
    await mkdirs(app, target);
    await adapter.write(`${target}/SKILL.md`, withLeftOut(node.fs.readFileSync(node.path.join(skill.dir, "SKILL.md"), "utf8"), leftOut));
    for (const rel of kept) {
      const dest = normalizePath(`${target}/${rel}`);
      await mkdirs(app, dest.slice(0, dest.lastIndexOf("/")));
      await adapter.write(dest, node.fs.readFileSync(node.path.join(skill.dir, rel), "utf8"));
    }
    result.copied.push(skill.name);
    if (skill.hasScripts) result.withoutScripts.push(skill.name);
  }
  return result;
}

/** Record left-out files in a copy's frontmatter, so use_skill can say so. */
function withLeftOut(raw: string, leftOut: string[]): string {
  const fm = getFrontMatterInfo(raw);
  if (leftOut.length === 0 || !fm.exists) return raw;
  // `to` can sit just before or just after the newline ending the last line.
  const head = raw.slice(0, fm.to).replace(/\r?\n$/, "");
  return `${head}\n${LEFT_OUT_KEY}: ${JSON.stringify(leftOut)}\n${raw.slice(fm.to).replace(/^\r?\n/, "")}`;
}

async function mkdirs(app: App, path: string): Promise<void> {
  if (!(await app.vault.adapter.exists(path))) await app.vault.adapter.mkdir(path);
}

function realpath(node: NodeModules, p: string): string {
  try {
    return node.fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Forward slashes, no trailing one, and one case where the disk ignores case (macOS, Windows). */
function comparablePath(p: string): string {
  const slashed = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return Platform.isMacOS || Platform.isWin ? slashed.toLowerCase() : slashed;
}

/**
 * Folders whose files the [[ menu leaves out, each ending in "/": the copies
 * folder, and every folder in the skills folder holding a SKILL.md. Read off
 * the vault rather than the loaded skills, so a skill that didn't load (bad
 * frontmatter, a name clash, a reload still pending) is hidden too. Other
 * notes in the skills folder stay.
 */
export function hiddenSkillDirs(app: App, folderSetting: string): string[] {
  const folder = skillsFolderPath(folderSetting);
  if (!folder) return [];
  const dirs = [`${folder}/${COPIES_FOLDER}/`];
  for (const f of app.vault.getFiles()) {
    if (f.name === "SKILL.md" && f.path.startsWith(folder + "/")) dirs.push(f.path.slice(0, -"SKILL.md".length));
  }
  return dirs;
}

/** Whether a vault path is inside the skills folder. */
export function inSkillsFolder(path: string, folderSetting: string): boolean {
  const folder = skillsFolderPath(folderSetting);
  return !!folder && (path === folder || path.startsWith(folder + "/"));
}
