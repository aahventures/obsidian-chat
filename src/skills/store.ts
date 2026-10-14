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
 * A vault skill wins over a Claude Code one with the same name, so a copy in
 * the vault can be edited without touching Claude Code's.
 *
 * Skills are plugin-wide rather than per session, so they live here rather
 * than on each AgentLoop.
 */
export interface Skill {
  name: string;
  description: string;
  /** SKILL.md without its frontmatter. */
  body: string;
  source: "vault" | "claude";
  /** The skill's folder: a vault path, or an absolute path on disk. */
  dir: string;
  /** Every other file in the folder, relative to it. */
  files: string[];
  /** Ships scripts, which can't run here. Its instructions still can be followed. */
  hasScripts: boolean;
}

/** A skill folder holding more than this is cut short rather than walked whole. */
const MAX_FILES = 100;
const SCRIPT_FILE = /(^|\/)scripts\/|\.(py|sh|bash|js|mjs|ts|rb|pl)$/i;

let skills: Skill[] = [];
/** Loads can overlap (a setting typed in, a file synced in); the newest wins. */
let loadGeneration = 0;

/** Every loaded skill, sorted by name so the system prompt built from it is stable. */
export function getSkills(): Skill[] {
  return skills;
}

export async function loadSkills(app: App, vaultFolder: string, useClaude: boolean): Promise<void> {
  const generation = ++loadGeneration;
  const found = new Map<string, Skill>();
  if (useClaude) for (const s of readClaudeSkills()) found.set(s.name, s);
  for (const s of await readVaultSkills(app, vaultFolder)) found.set(s.name, s);
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
  if (skill.source === "vault") return app.vault.adapter.read(`${skill.dir}/${rel}`);
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
  return {
    name,
    description: description.replace(/\s+/g, " "),
    body: raw.slice(fm.contentStart).trim(),
    source,
    dir,
    files,
    hasScripts: files.some((f) => SCRIPT_FILE.test(f)),
  };
}

// ─── Vault folder ───────────────────────────────────────────────────────────

/**
 * `<folder>/<name>/SKILL.md`. Read through the adapter rather than the vault
 * index, so a folder Obsidian doesn't index (a dot-folder) still works.
 */
async function readVaultSkills(app: App, folderSetting: string): Promise<Skill[]> {
  const folder = skillsFolderPath(folderSetting);
  if (!folder) return [];
  const adapter = app.vault.adapter;
  const out: Skill[] = [];
  try {
    if (!(await adapter.exists(folder))) return [];
    for (const dir of (await adapter.list(folder)).folders) {
      const skillFile = `${dir}/SKILL.md`;
      if (!(await adapter.exists(skillFile))) continue;
      const files = (await listVaultFiles(app, dir)).filter((f) => f !== "SKILL.md");
      const skill = parseSkill(await adapter.read(skillFile), dir.split("/").pop() ?? dir, "vault", dir, files);
      if (skill) out.push(skill);
    }
  } catch (e) {
    console.warn("Obsidian Chat: couldn't read skills folder", e);
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
    readFileSync(p: string): Uint8Array;
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

/**
 * Copy every Claude Code skill into the vault folder, so devices without
 * Claude Code (phones) get them through sync. Overwrites files of the same
 * name and leaves anything else in the folder alone. Returns how many skills
 * were copied.
 */
export async function copyClaudeSkillsToVault(app: App, folderSetting: string): Promise<number> {
  const node = nodeModules();
  const folder = skillsFolderPath(folderSetting);
  if (!node || !folder) return 0;
  const adapter = app.vault.adapter;

  let copied = 0;
  for (const skill of readClaudeSkills()) {
    const target = `${folder}/${skill.dir.split(/[\\/]/).pop()}`;
    for (const rel of ["SKILL.md", ...skill.files]) {
      const dest = normalizePath(`${target}/${rel}`);
      const parent = dest.slice(0, dest.lastIndexOf("/"));
      if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
      const buf = node.fs.readFileSync(node.path.join(skill.dir, rel));
      await adapter.writeBinary(dest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    }
    copied++;
  }
  return copied;
}
