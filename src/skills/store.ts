import { App, Platform, TFile, TFolder, getFrontMatterInfo, normalizePath, parseYaml } from "obsidian";

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
 * the skills folder (`Claude Code/`). The plugin owns it: each copy brings it
 * up to date (changed files written, stale ones removed), and nothing else in
 * the skills folder is ever written. When names clash,
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
  /** Every other file in the folder, relative to it, up to MAX_FILES. */
  files: string[];
  /** The folder had more than MAX_FILES other files; `files` stops there. */
  truncated: boolean;
  /** On a copy: files of the original that weren't copied (scripts, binaries). */
  leftOut: string[];
  /** Ships scripts, which can't run here. Its instructions still can be followed. */
  hasScripts: boolean;
}

/** The folder in the skills folder that holds copies of Claude Code's skills. */
export const COPIES_FOLDER = "Claude Code";
/** Frontmatter key a copy's SKILL.md records its left-out files under. */
const LEFT_OUT_KEY = "obsidian-chat-left-out";

/**
 * A skill folder holding more files than this is cut short rather than walked
 * whole. One cap for loading and copying, so a copy never holds files the
 * loader can't see.
 */
const MAX_FILES = 1000;
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
  listed: string[]
): Skill | null {
  // Listings run one past the cap, so going over it shows.
  const files = listed.slice(0, MAX_FILES);
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
    truncated: listed.length > MAX_FILES,
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
    try {
      if (!(await adapter.exists(skillFile))) continue;
      const files = (await listVaultFiles(app, dir)).filter((f) => f !== "SKILL.md");
      const skill = parseSkill(await adapter.read(skillFile), dir.split("/").pop() ?? dir, source, dir, files);
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
  return scanClaudeSkills().skills;
}

/**
 * The skills, plus every folder that looked like a skill (or held skills) but
 * couldn't be read or parsed. Copying uses `problems` to know when "not
 * found" might only mean "not readable right now".
 */
function scanClaudeSkills(): { skills: Skill[]; problems: string[] } {
  const result = { skills: [] as Skill[], problems: [] as string[] };
  const node = nodeModules();
  const root = claudeSkillsDir();
  if (!node || !root) return result;
  const { fs, path } = node;

  const parents = [root];
  const synced = path.join(root, "synced");
  if (isDir(fs, synced)) {
    try {
      for (const account of fs.readdirSync(synced)) {
        const p = path.join(synced, account);
        if (isDir(fs, p)) parents.push(p);
      }
    } catch {
      result.problems.push(synced);
    }
  }
  for (const parent of parents) {
    let names: string[];
    try {
      names = fs.readdirSync(parent);
    } catch {
      result.problems.push(parent);
      continue;
    }
    for (const name of names) {
      const dir = path.join(parent, name);
      const skillFile = path.join(dir, "SKILL.md");
      // isDir follows symlinks, so a skill linked in from the vault counts.
      if (!isDir(fs, dir) || !fs.existsSync(skillFile)) continue;
      try {
        const files = listDiskFiles(node, dir).filter((f) => f !== "SKILL.md");
        const skill = parseSkill(fs.readFileSync(skillFile, "utf8"), name, "claude", dir, files);
        if (skill) result.skills.push(skill);
        else result.problems.push(dir);
      } catch {
        // One unreadable skill shouldn't hide the rest.
        result.problems.push(dir);
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

export interface CopyResult {
  /** Where the copies went. */
  folder: string;
  copied: string[];
  /** Copied skills whose scripts were left out, since scripts can't run here. */
  withoutScripts: string[];
  /** Skills whose real folder is in the skills folder already (symlinked into ~/.claude). */
  alreadyThere: string[];
  /** Skills that couldn't be read or copied; any earlier copies of them are kept. */
  failed: string[];
  /** Something in ~/.claude/skills couldn't be read, so no old copies were removed. */
  sweepSkipped: boolean;
}

/**
 * Bring `<skills folder>/Claude Code/` up to date with Claude Code's skills, so
 * devices without Claude Code (phones) get them through sync. Nothing outside
 * that folder is written. Each skill is read whole before its copy changes,
 * only files that differ are written, and old copies are removed only when
 * every skill could be read, so a skill that's unreadable for a moment keeps
 * its copy. Text files come across; scripts and binaries don't, and the
 * copy's SKILL.md lists what was left out.
 */
export async function copyClaudeSkillsToVault(app: App, folderSetting: string): Promise<CopyResult> {
  const folder = skillsFolderPath(folderSetting);
  const copiesDir = `${folder}/${COPIES_FOLDER}`;
  const result: CopyResult = {
    folder: copiesDir, copied: [], withoutScripts: [], alreadyThere: [], failed: [], sweepSkipped: false,
  };
  const node = nodeModules();
  if (!node || !folder) return result;
  const adapter = app.vault.adapter;
  const made = new Set<string>();
  const mkdirs = async (path: string) => {
    if (made.has(path)) return;
    if (!(await adapter.exists(path))) await adapter.mkdir(path);
    made.add(path);
  };
  await mkdirs(folder);
  await mkdirs(copiesDir);
  const base = "getBasePath" in adapter && typeof adapter.getBasePath === "function"
    ? (adapter.getBasePath() as string)
    : null;
  // Resolved once the folders exist, so both sides of the comparison are real paths.
  const skillsRoot = base ? comparablePath(realpath(node, node.path.join(base, folder))) : null;
  const copiesRoot = base ? comparablePath(realpath(node, node.path.join(base, copiesDir))) : null;

  const scan = scanClaudeSkills();
  // One copy per name, as loadSkills keys them: a later skill (an account's
  // synced one) replaces a same-named one from the top of ~/.claude/skills.
  const byName = new Map<string, Skill>();
  for (const skill of scan.skills) byName.set(skill.name.toLowerCase(), skill);

  // A ~/.claude entry whose real folder is in Claude Code/ (linked there) must
  // never be written over or removed, whether or not it parses as a skill.
  const protectedDirs = new Set<string>();
  const protect = (dir: string) => {
    const real = comparablePath(realpath(node, dir));
    if (copiesRoot && real.startsWith(copiesRoot + "/")) {
      protectedDirs.add(real.slice(copiesRoot.length + 1).split("/")[0].normalize("NFC").toLowerCase());
    }
  };
  for (const dir of scan.problems) protect(dir);
  for (const skill of scan.skills) protect(skill.dir); // losers of a name clash too

  // Skills linked in from the skills folder are your own, loaded from there.
  const toCopy: Skill[] = [];
  for (const skill of byName.values()) {
    const real = comparablePath(realpath(node, skill.dir));
    if (skillsRoot && real.startsWith(skillsRoot + "/")) result.alreadyThere.push(skill.name);
    else toCopy.push(skill);
  }

  const live = new Set<string>(protectedDirs);
  for (const skill of toCopy) {
    const target = copyFolderName(skill.name);
    live.add(target);
    if (protectedDirs.has(target)) {
      result.failed.push(skill.name);
      continue;
    }
    // Read the whole skill before its copy changes.
    let files: Map<string, string>;
    const leftOut: string[] = [];
    try {
      const raw = node.fs.readFileSync(node.path.join(skill.dir, "SKILL.md"), "utf8");
      files = new Map();
      for (const rel of skill.files) {
        if (!TEXT_FILE.test(rel) || SCRIPT_FILE.test(rel)) {
          leftOut.push(rel);
          continue;
        }
        try {
          files.set(normalizePath(rel), node.fs.readFileSync(node.path.join(skill.dir, rel), "utf8"));
        } catch {
          leftOut.push(rel); // one unreadable reference shouldn't sink the skill
        }
      }
      if (skill.truncated) leftOut.push(`(more files past the first ${MAX_FILES})`);
      files.set("SKILL.md", withLeftOut(raw, leftOut));
    } catch {
      result.failed.push(skill.name);
      continue;
    }

    const dir = `${copiesDir}/${target}`;
    for (const [rel, content] of files) {
      const dest = `${dir}/${rel}`;
      if (await sameContent(app, dest, content)) continue;
      await mkdirs(dest.slice(0, dest.lastIndexOf("/")));
      await adapter.write(dest, content);
    }
    // Files an earlier copy had that this one doesn't.
    for (const rel of await listVaultFiles(app, dir)) {
      if (!files.has(rel)) await adapter.remove(`${dir}/${rel}`);
    }
    result.copied.push(skill.name);
    if (skill.hasScripts || leftOut.some((f) => SCRIPT_FILE.test(f))) result.withoutScripts.push(skill.name);
  }

  // Remove copies whose skill is gone, but only when every skill could be
  // read: one that's unreadable for a moment would otherwise lose its copy.
  if (scan.problems.length > 0) {
    result.sweepSkipped = true;
    return result;
  }
  const listing = await adapter.list(copiesDir);
  for (const dir of listing.folders) {
    const name = dir.slice(copiesDir.length + 1).normalize("NFC").toLowerCase();
    if (!live.has(name)) await adapter.rmdir(dir, true);
  }
  for (const file of listing.files) await adapter.remove(file);
  return result;
}

/**
 * A copy's folder name: the skill name, lowercased, with anything that could
 * break a path or sync %-escaped (separators, reserved characters, a leading
 * dot, a trailing dot or space). Fixed for a given name and never shared by
 * two names, so a copy always lands in the same folder, whatever the case
 * rules of the disk or the order skills are found in.
 */
function copyFolderName(name: string): string {
  const esc = (c: string) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0");
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\\/:*?"<>|%\x00-\x1f]/g, esc)
    .replace(/^\./, esc)
    .replace(/[. ]$/, esc);
}

/** Whether a vault file already holds `content`. Compares sizes first, so a changed file isn't read. */
async function sameContent(app: App, path: string, content: string): Promise<boolean> {
  const stat = await app.vault.adapter.stat(path);
  if (!stat || stat.type !== "file") return false;
  if (stat.size !== new TextEncoder().encode(content).length) return false;
  return (await app.vault.adapter.read(path)) === content;
}

/** Record left-out files in a copy's frontmatter, so use_skill can say so. */
function withLeftOut(raw: string, leftOut: string[]): string {
  const fm = getFrontMatterInfo(raw);
  if (!fm.exists) return raw;
  // `to` can sit just before or just after the newline ending the last line.
  // A key already there (a copy that came back round) is replaced, not
  // doubled, along with any block-list lines under it.
  const lines = raw.slice(0, fm.to).replace(/\r?\n$/, "").split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`${LEFT_OUT_KEY}:`)) {
      kept.push(lines[i]);
      continue;
    }
    while (i + 1 < lines.length && /^(\s|-\s|-$)/.test(lines[i + 1])) i++;
  }
  const tail = raw.slice(fm.to).replace(/^\r?\n/, "");
  if (leftOut.length > 0) kept.push(`${LEFT_OUT_KEY}: ${JSON.stringify(leftOut)}`);
  return `${kept.join("\n")}\n${tail}`;
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
 * folder, and every folder in the skills folder holding a SKILL.md (any case,
 * as the loader finds it on macOS and Windows). Read off the vault's folder
 * tree rather than the loaded skills, so a skill that didn't load (bad
 * frontmatter, a name clash, a reload still pending) is hidden too, and only
 * the skills folder's own children are looked at, not the whole vault.
 * Other notes in the skills folder stay.
 */
export function hiddenSkillDirs(app: App, folderSetting: string): string[] {
  const folder = skillsFolderPath(folderSetting);
  if (!folder) return [];
  const root = app.vault.getFolderByPath(folder);
  if (!root) return [];
  const dirs = [`${folder}/${COPIES_FOLDER}/`];
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    if (child.children.some((f) => f instanceof TFile && f.name.toLowerCase() === "skill.md")) dirs.push(child.path + "/");
  }
  return dirs;
}

/** Whether a vault path is inside the skills folder. */
export function inSkillsFolder(path: string, folderSetting: string): boolean {
  const folder = skillsFolderPath(folderSetting);
  return !!folder && (path === folder || path.startsWith(folder + "/"));
}
