import { App } from "obsidian";
import type {
  AgentCallbacks,
  ChatSession,
  ChatSettings,
  SelectionScope,
  SessionEvent,
  UiChatMessage,
} from "../types";
import { createProviderState } from "../types";
import { AgentLoop } from "./loop";

const STATE_PATH = ".obsidian/plugins/obsidian-chat/chat-sessions.json";
/** Pre-session persistence file, migrated into a single session on first load. */
const LEGACY_STATE_PATH = ".obsidian/plugins/obsidian-chat/chat-state.json";

const MAX_UI_MESSAGES = 100;
const MAX_AGENT_MESSAGES = 80;
const SAVE_DEBOUNCE_MS = 500;
const TITLE_MAX_LENGTH = 40;

export const UNTITLED_SESSION = "New chat";

type SessionListener = (event: SessionEvent) => void;

/** A session plus the runtime state that is not persisted. */
interface LiveSession {
  record: ChatSession;
  loop: AgentLoop;
  running: boolean;
  /** Resolver for an in-flight ask_user question, if the agent is parked on one. */
  askResolve: ((answer: string) => void) | null;
  listeners: Set<SessionListener>;
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Derive a tab-friendly title from the first thing the user said. */
export function deriveTitle(message: string): string {
  const firstLine = message.trim().split("\n")[0].trim();
  if (!firstLine) return UNTITLED_SESSION;
  if (firstLine.length <= TITLE_MAX_LENGTH) return firstLine;
  return `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Owns every chat session and is the single entry point for running a turn.
 *
 * Turn orchestration lives here rather than in the view on purpose: a run's
 * lifetime must not be tied to whether a pane happens to be open. Callbacks
 * write into the session record unconditionally and only then notify whichever
 * views are listening, so a session switched away from keeps working and its
 * results are waiting when a view binds to it again.
 */
export class SessionStore {
  private app: App;
  private settings: ChatSettings;
  private sessions = new Map<string, LiveSession>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  // ─── Lookup ───────────────────────────────────────────────────────────────

  /** All sessions, most recently updated first. */
  list(): ChatSession[] {
    return [...this.sessions.values()]
      .map((s) => s.record)
      // Tie-break on creation so equal timestamps still order newest-first
      // rather than falling back to Map insertion order (i.e. oldest first).
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  get(id: string): ChatSession | null {
    return this.sessions.get(id)?.record ?? null;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false;
  }

  /** The question the agent is waiting on, if any. */
  pendingQuestion(id: string): string | null {
    return this.sessions.get(id)?.record.pendingQuestion ?? null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  create(): ChatSession {
    const now = Date.now();
    const record: ChatSession = {
      id: newSessionId(),
      title: UNTITLED_SESSION,
      createdAt: now,
      updatedAt: now,
      uiMessages: [],
      agentMessages: [],
      providerState: createProviderState(),
      pendingQuestion: null,
    };
    this.sessions.set(record.id, this.toLive(record));
    this.scheduleSave();
    return record;
  }

  delete(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.releaseAsk(session);
    session.loop.abort();
    session.listeners.clear();
    this.sessions.delete(id);
    this.scheduleSave();
  }

  /** Wipe a session's messages but keep the session itself. */
  clearMessages(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.releaseAsk(session);
    // Order matters: AgentLoop.clear() resets the abort flag, so aborting must
    // come last or an in-flight run would carry on into the fresh history.
    session.loop.clear();
    session.loop.abort();
    session.running = false;
    session.record.uiMessages = [];
    session.record.agentMessages = [];
    session.record.providerState = createProviderState();
    session.record.pendingQuestion = null;
    // Back to untitled, or the next message never re-derives a title (`run()`
    // only titles an untitled session) and the switcher would label this
    // conversation after the one that was just deleted.
    session.record.title = UNTITLED_SESSION;
    session.record.updatedAt = Date.now();
    this.emit(session, { kind: "title", title: session.record.title });
    this.emit(session, { kind: "cleared" });
    this.emit(session, { kind: "running", running: false });
    this.scheduleSave();
  }

  rename(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.record.title = title.trim() || UNTITLED_SESSION;
    this.emit(session, { kind: "title", title: session.record.title });
    this.scheduleSave();
  }

  transcript(id: string): string {
    return this.sessions.get(id)?.loop.exportTranscript() ?? "";
  }

  /** Stop a session's run. Does not delete anything. */
  abort(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.loop.abort();
    this.releaseAsk(session);
    session.running = false;
    this.emit(session, { kind: "running", running: false });
    this.scheduleSave();
  }

  /** Stop everything. Called on plugin unload. */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.loop.abort();
      this.releaseAsk(session);
      session.running = false;
    }
  }

  // ─── Subscription ─────────────────────────────────────────────────────────

  /** Listen to a session's events. Returns an unsubscribe function. */
  subscribe(id: string, listener: SessionListener): () => void {
    const session = this.sessions.get(id);
    if (!session) return () => {};
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  // ─── Running a turn ───────────────────────────────────────────────────────

  /**
   * Send a user message and run the agent loop to completion.
   *
   * If the agent is parked on an ask_user question, the text answers it instead
   * of starting a new turn.
   */
  async run(
    id: string,
    text: string,
    selection: SelectionScope | null
  ): Promise<"started" | "answered" | "busy" | "unknown"> {
    const session = this.sessions.get(id);
    if (!session) return "unknown";

    if (session.askResolve) {
      this.answer(session, text);
      return "answered";
    }

    if (session.running) return "busy";

    session.running = true;
    this.emit(session, { kind: "running", running: true });

    this.append(session, { type: "user", text });

    if (session.record.title === UNTITLED_SESSION) {
      session.record.title = deriveTitle(text);
      this.emit(session, { kind: "title", title: session.record.title });
    }

    try {
      await session.loop.run(text, this.makeCallbacks(session), selection);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.append(session, { type: "error", text: `Unexpected error: ${message}` });
    } finally {
      session.running = false;
      session.record.pendingQuestion = null;
      session.askResolve = null;
      this.syncFromLoop(session);
      this.emit(session, { kind: "running", running: false });
      this.scheduleSave();
    }

    return "started";
  }

  private makeCallbacks(session: LiveSession): AgentCallbacks {
    return {
      onThinking: () => this.emit(session, { kind: "thinking", on: true }),

      onToolCall: (toolId, name, input) => {
        this.emit(session, { kind: "thinking", on: false });
        // ask_user is a UI affordance, not something to render as a tool call.
        if (name === "ask_user") return;
        this.append(session, {
          type: "tool-call",
          toolId,
          toolName: name,
          toolInput: input,
        });
      },

      onToolResult: (toolId, name, result) => {
        if (name === "ask_user") return;
        // Attach the result to its own call, matched by id.
        const call = session.record.uiMessages.find(
          (m) => m.type === "tool-call" && m.toolId === toolId
        );
        if (call) call.toolResult = result;
        session.record.updatedAt = Date.now();
        this.emit(session, { kind: "tool-result", toolId, toolName: name, result });
        this.scheduleSave();
      },

      onResponse: (text) => {
        this.emit(session, { kind: "thinking", on: false });
        this.append(session, { type: "assistant", text });
      },

      onAskUser: (question) => {
        this.emit(session, { kind: "thinking", on: false });
        session.record.pendingQuestion = question;
        // Persist the question as an assistant message so it replays on rebind.
        this.append(session, { type: "assistant", text: question });
        this.emit(session, { kind: "ask-user", question });
        return new Promise<string>((resolve) => {
          session.askResolve = resolve;
        });
      },

      onError: (error) => {
        this.emit(session, { kind: "thinking", on: false });
        this.append(session, { type: "error", text: error });
      },
    };
  }

  /** Answer a pending ask_user question, resuming the parked loop. */
  private answer(session: LiveSession, text: string): void {
    const resolve = session.askResolve;
    if (!resolve) return;
    session.askResolve = null;
    session.record.pendingQuestion = null;
    this.append(session, { type: "user", text });
    // The turn never stopped, so put the input back into its waiting state.
    // Without this it stays enabled for the rest of the run and anything typed
    // is swallowed by the busy check in `run()` — cleared from the box and
    // never appended anywhere.
    this.emit(session, { kind: "running", running: true });
    resolve(text);
  }

  /**
   * Unblock a parked loop without an answer, so it can observe its abort flag
   * instead of awaiting a promise nobody will ever resolve.
   */
  private releaseAsk(session: LiveSession): void {
    const resolve = session.askResolve;
    if (!resolve) return;
    session.askResolve = null;
    session.record.pendingQuestion = null;
    resolve("");
  }

  // ─── Internal state plumbing ──────────────────────────────────────────────

  private toLive(record: ChatSession): LiveSession {
    const loop = new AgentLoop(this.app, this.settings);
    loop.importMessages(record.agentMessages);
    loop.importProviderState(record.providerState);
    return {
      record,
      loop,
      running: false,
      askResolve: null,
      listeners: new Set(),
    };
  }

  private append(session: LiveSession, message: UiChatMessage): void {
    session.record.uiMessages.push(message);
    if (session.record.uiMessages.length > MAX_UI_MESSAGES) {
      session.record.uiMessages = session.record.uiMessages.slice(-MAX_UI_MESSAGES);
    }
    session.record.updatedAt = Date.now();
    this.emit(session, { kind: "message", message });
    this.scheduleSave();
  }

  private emit(session: LiveSession, event: SessionEvent): void {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {
        // A broken view must not derail the agent loop.
      }
    }
  }

  /**
   * Pull the loop's authoritative state back into the persisted record.
   *
   * `save()` calls this for every session, so it must stay free of per-session
   * side effects — notably `updatedAt`, which belongs where a conversation
   * actually changes.
   */
  private syncFromLoop(session: LiveSession): void {
    session.record.agentMessages = session.loop.exportMessages();
    session.record.providerState = session.loop.exportProviderState();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const payload = {
        version: 2,
        sessions: [...this.sessions.values()].map((session) => {
          this.syncFromLoop(session);
          return {
            ...session.record,
            uiMessages: session.record.uiMessages.slice(-MAX_UI_MESSAGES),
            agentMessages: session.record.agentMessages.slice(-MAX_AGENT_MESSAGES),
          };
        }),
      };
      await this.app.vault.adapter.write(STATE_PATH, JSON.stringify(payload));
    } catch {
      // Persistence is best-effort.
    }
  }

  /** Restore sessions from disk, migrating pre-session state if present. */
  async load(): Promise<void> {
    const restored = (await this.readSessions()) ?? (await this.readLegacySession());

    if (restored && restored.length > 0) {
      for (const record of restored) {
        this.sessions.set(record.id, this.toLive(record));
      }
      return;
    }

    // Nothing to restore — start with one empty session.
    this.create();
  }

  private async readSessions(): Promise<ChatSession[] | null> {
    try {
      const raw = await this.app.vault.adapter.read(STATE_PATH);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.sessions)) return null;
      const sessions = parsed.sessions
        .map((s: unknown) => normalizeSession(s))
        .filter((s: ChatSession | null): s is ChatSession => s !== null);
      return sessions.length > 0 ? sessions : null;
    } catch {
      return null;
    }
  }

  /**
   * Migrate the single pre-session conversation from chat-state.json.
   * The old file is left in place so downgrading does not lose it.
   */
  private async readLegacySession(): Promise<ChatSession[] | null> {
    try {
      const raw = await this.app.vault.adapter.read(LEGACY_STATE_PATH);
      const parsed = JSON.parse(raw);

      const uiMessages: UiChatMessage[] = Array.isArray(parsed?.chatHistory)
        ? parsed.chatHistory.map(migrateLegacyMessage).filter(Boolean)
        : [];
      const agentMessages = Array.isArray(parsed?.agentMessages) ? parsed.agentMessages : [];

      if (uiMessages.length === 0 && agentMessages.length === 0) return null;

      const firstUser = uiMessages.find((m) => m.type === "user");
      const now = Date.now();

      return [
        {
          id: newSessionId(),
          title: firstUser?.text ? deriveTitle(firstUser.text) : "Imported chat",
          createdAt: now,
          updatedAt: now,
          uiMessages,
          agentMessages,
          providerState: createProviderState(),
          pendingQuestion: null,
        },
      ];
    } catch {
      return null;
    }
  }
}

/**
 * The pre-session format stored tool results as their own `"tool-result"`
 * entry. Fold those into a single `"tool-call"` message carrying its result,
 * which is how a call and its outcome are represented now.
 */
function migrateLegacyMessage(raw: unknown): UiChatMessage | null {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m.type !== "string") return null;

  if (m.type === "tool-result") {
    if (typeof m.toolName !== "string" || !m.toolResult) return null;
    return {
      type: "tool-call",
      toolName: m.toolName,
      toolInput: (m.toolInput as Record<string, unknown>) || {},
      toolResult: m.toolResult as UiChatMessage["toolResult"],
    };
  }

  if (m.type === "user" || m.type === "assistant" || m.type === "error") {
    return { type: m.type, text: typeof m.text === "string" ? m.text : "" };
  }

  return null;
}

/** Defensively coerce a parsed session, dropping anything unusable. */
function normalizeSession(raw: unknown): ChatSession | null {
  const s = raw as Partial<ChatSession>;
  if (!s || typeof s.id !== "string" || !s.id) return null;

  const now = Date.now();
  return {
    id: s.id,
    title: typeof s.title === "string" && s.title ? s.title : UNTITLED_SESSION,
    createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
    updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now,
    uiMessages: Array.isArray(s.uiMessages) ? s.uiMessages : [],
    agentMessages: Array.isArray(s.agentMessages) ? s.agentMessages : [],
    // Deliberately NOT restored: a chain id can be dead (expired server-side,
    // belonging to another org after a key change, or ending on a tool call
    // that was aborted before its result was sent). Nothing invalidates a bad
    // id yet, so restoring one would make a broken conversation stay broken
    // across restarts — today a reload is the only way out. Start unchained.
    providerState: createProviderState(),
    // A question parked at save time has no resolver after a restart.
    pendingQuestion: null,
  };
}
