import { App } from "obsidian";
import type {
  AgentCallbacks,
  ChatSettings,
  ChatHistoryEntry,
  SelectionScope,
  SessionEvent,
  SessionSnapshot,
  PersistedChatState,
} from "./types";
import { AgentLoop, trimToTurns } from "./agent/loop";

/** Cap on UI transcript entries kept per session when persisting. */
const MAX_HISTORY_PER_SESSION = 100;
/** Cap on API messages kept per session when persisting. */
const MAX_AGENT_MESSAGES_PER_SESSION = 80;
/**
 * Cap on retained sessions. Sessions are never deleted from the UI, so
 * without a bound `chat-state.json` would grow forever. Least-recently-used
 * sessions are evicted first; the active session is never evicted.
 */
const MAX_SESSIONS = 20;

/** Longest auto-derived title before ellipsis. */
const MAX_TITLE_LENGTH = 40;

const UNTITLED = "New chat";

type SessionListener = (event: SessionEvent) => void;

/**
 * One conversation: its own transcript, its own AgentLoop (and therefore its
 * own API message history and provider chaining state).
 */
export class ChatSession {
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  chatHistory: ChatHistoryEntry[] = [];
  readonly agent: AgentLoop;

  // Runtime only, never persisted.
  running = false;
  /** The question the agent is parked on, if any. */
  pendingQuestion: string | null = null;
  /** Resumes the parked ask_user call. */
  askResolve: ((answer: string) => void) | null = null;
  /**
   * Bumped by each turn, Stop and Clear. A stopped turn's promise still settles
   * later, and only the current turn may mark the session idle when it does.
   */
  turn = 0;
  readonly listeners = new Set<SessionListener>();

  constructor(app: App, settings: ChatSettings, id?: string, createdAt?: number) {
    this.id = id ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.title = UNTITLED;
    this.agent = new AgentLoop(app, settings);
  }

  /** Nothing has been said in this session and nothing is happening in it. */
  get isEmpty(): boolean {
    return this.chatHistory.length === 0 && !this.running && !this.askResolve;
  }

  /**
   * Title the session from its first user message, once. Titles are derived
   * rather than model-generated so that opening a chat never costs a call.
   */
  maybeTitleFrom(text: string): void {
    if (this.title !== UNTITLED) return;
    const flat = text.replace(/\s+/g, " ").trim();
    if (!flat) return;
    this.title =
      flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      chatHistory: this.chatHistory.slice(-MAX_HISTORY_PER_SESSION),
      agentMessages: trimToTurns(this.agent.exportMessages(), MAX_AGENT_MESSAGES_PER_SESSION),
      openai: this.agent.exportOpenAIState(),
    };
  }

  static fromSnapshot(app: App, settings: ChatSettings, snap: SessionSnapshot): ChatSession {
    const session = new ChatSession(app, settings, snap.id, snap.createdAt);
    session.title = snap.title || UNTITLED;
    session.updatedAt = snap.updatedAt ?? snap.createdAt ?? Date.now();
    session.chatHistory = Array.isArray(snap.chatHistory) ? snap.chatHistory : [];
    if (Array.isArray(snap.agentMessages)) {
      session.agent.importMessages(snap.agentMessages);
    }
    session.agent.importOpenAIState(snap.openai);
    return session;
  }
}

/**
 * Holds every open conversation and which one the view is showing, and runs
 * their turns.
 *
 * Turns run here rather than in the view so that a run's lifetime isn't tied
 * to a view being open. Callbacks write into the session first and only then
 * tell whichever views are listening, so a session nobody is looking at keeps
 * working and its results are there when a view shows it again.
 *
 * Sessions are deliberately not scoped to a note — the plugin's reach across
 * the whole vault is the point, and a session that followed the active file
 * would undo that.
 */
export class SessionStore {
  private sessions: ChatSession[] = [];
  private activeId: string | null = null;

  /** Called whenever there is something worth saving. Set by the plugin. */
  onChange: () => void = () => {};

  constructor(
    private app: App,
    private settings: ChatSettings
  ) {}

  // ─── Running a turn ───────────────────────────────────────────────────

  /** Listen to a session's events. Returns an unsubscribe function. */
  subscribe(id: string, listener: SessionListener): () => void {
    const session = this.get(id);
    if (!session) return () => {};
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  /**
   * Send a user message and run the agent to the end of its turn. If the agent
   * is parked on an ask_user question, the text answers it instead.
   */
  async run(
    id: string,
    text: string,
    selection: SelectionScope | null
  ): Promise<"started" | "answered" | "busy" | "unknown"> {
    const session = this.get(id);
    if (!session) return "unknown";

    if (session.askResolve) {
      this.answer(session, text);
      return "answered";
    }
    if (session.running) return "busy";

    const turn = ++session.turn;
    session.running = true;
    this.emit(session, { kind: "running", running: true });
    this.append(session, { type: "user", text });

    const title = session.title;
    session.maybeTitleFrom(text);
    if (session.title !== title) this.emit(session, { kind: "title", title: session.title });

    try {
      await session.agent.run(text, this.callbacks(session), selection);
    } catch (e) {
      if (turn === session.turn) {
        const message = e instanceof Error ? e.message : String(e);
        this.append(session, { type: "error", text: `Unexpected error: ${message}` });
      }
    } finally {
      if (turn === session.turn) {
        session.running = false;
        session.pendingQuestion = null;
        session.askResolve = null;
        this.emit(session, { kind: "running", running: false });
      }
      session.touch();
      this.onChange();
    }
    return "started";
  }

  /** Stop a session's turn. Keeps everything said so far. */
  abort(id: string): void {
    const session = this.get(id);
    if (!session) return;
    this.stop(session);
    this.emit(session, { kind: "running", running: false });
    this.onChange();
  }

  /**
   * Empty a session in place. This keeps the session (and its position in the
   * switcher) rather than deleting it, which is what the command has always
   * meant. The title goes back to untitled so the next message names it,
   * instead of the switcher labeling it after the conversation just cleared.
   */
  clearMessages(id: string): void {
    const session = this.get(id);
    if (!session) return;
    this.stop(session);
    session.agent.clear();
    session.chatHistory = [];
    session.title = UNTITLED;
    session.touch();
    this.emit(session, { kind: "title", title: session.title });
    this.emit(session, { kind: "cleared" });
    this.emit(session, { kind: "running", running: false });
    this.onChange();
  }

  /** Stop every turn. Only plugin unload does this; closing a view doesn't. */
  abortAll(): void {
    for (const session of this.sessions) this.stop(session);
  }

  private stop(session: ChatSession): void {
    session.agent.abort();
    this.releaseAsk(session);
    session.turn++;
    session.running = false;
  }

  private callbacks(session: ChatSession): AgentCallbacks {
    return {
      onThinking: () => this.emit(session, { kind: "thinking", on: true }),

      onToolCall: (toolId, name, input) => {
        this.emit(session, { kind: "thinking", on: false });
        // ask_user is shown as a question, not as a tool call.
        if (name === "ask_user") return;
        this.append(session, { type: "tool-call", toolId, toolName: name, toolInput: input });
      },

      onToolResult: (toolId, name, result) => {
        if (name === "ask_user") return;
        const call = findLast(
          session.chatHistory,
          (e) => e.type === "tool-call" && e.toolId === toolId
        );
        if (call) call.toolResult = result;
        session.touch();
        this.emit(session, { kind: "tool-result", toolId, toolName: name, result });
      },

      onResponse: (text) => {
        this.emit(session, { kind: "thinking", on: false });
        this.append(session, { type: "assistant", text });
      },

      onAskUser: (question) => {
        this.emit(session, { kind: "thinking", on: false });
        session.pendingQuestion = question;
        // Recorded as an assistant message so it replays with the session.
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

  /** Answer the question the agent is parked on, resuming its turn. */
  private answer(session: ChatSession, text: string): void {
    const resolve = session.askResolve;
    if (!resolve) return;
    session.askResolve = null;
    session.pendingQuestion = null;
    this.append(session, { type: "user", text });
    // The turn never ended, so put the input back into its waiting state.
    this.emit(session, { kind: "running", running: true });
    resolve(text);
  }

  /**
   * Resume a parked ask_user with no answer, so a stopped turn can finish and
   * notice it was stopped instead of waiting forever.
   */
  private releaseAsk(session: ChatSession): void {
    const resolve = session.askResolve;
    if (!resolve) return;
    session.askResolve = null;
    session.pendingQuestion = null;
    resolve("");
  }

  private append(session: ChatSession, entry: ChatHistoryEntry): void {
    session.chatHistory.push(entry);
    session.touch();
    this.emit(session, { kind: "message", entry });
  }

  private emit(session: ChatSession, event: SessionEvent): void {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch {
        // A broken view must not derail the agent.
      }
    }
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  /** Every session, most recently used first. */
  list(): ChatSession[] {
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get count(): number {
    return this.sessions.length;
  }

  /** The active session, creating the first one on demand. */
  active(): ChatSession {
    const found = this.sessions.find((s) => s.id === this.activeId);
    if (found) return found;
    if (this.sessions.length > 0) {
      const fallback = this.list()[0];
      this.activeId = fallback.id;
      return fallback;
    }
    return this.create();
  }

  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Start a new session and make it active. */
  create(): ChatSession {
    const session = new ChatSession(this.app, this.settings);
    this.sessions.push(session);
    this.activeId = session.id;
    this.evict();
    return session;
  }

  /**
   * Reuse the active session when it is still untouched rather than stacking
   * up blank chats. "New chat" pressed twice in a row should not leave an
   * empty session behind.
   */
  createOrReuseEmpty(): ChatSession {
    const current = this.sessions.find((s) => s.id === this.activeId);
    if (current && current.isEmpty) return current;
    return this.create();
  }

  setActive(id: string): ChatSession | undefined {
    const session = this.get(id);
    if (session) this.activeId = id;
    return session;
  }

  /** Drop least-recently-used sessions past the cap, never the active one. */
  private evict(): void {
    if (this.sessions.length <= MAX_SESSIONS) return;
    const keep = new Set(
      this.list()
        .slice(0, MAX_SESSIONS)
        .map((s) => s.id)
    );
    if (this.activeId) keep.add(this.activeId);
    this.sessions = this.sessions.filter((s) => keep.has(s.id));
  }

  toPersisted(): PersistedChatState {
    return {
      version: 2,
      activeSessionId: this.activeId,
      sessions: this.list().map((s) => s.toSnapshot()),
    };
  }

  /**
   * Restore from disk. Accepts the pre-multi-session shape
   * (`{ chatHistory, agentMessages }`) and migrates it into a single session,
   * so an upgrade never loses the conversation in progress.
   */
  restore(raw: unknown): void {
    this.sessions = [];
    this.activeId = null;
    if (!raw || typeof raw !== "object") return;
    const state = raw as Partial<PersistedChatState> & {
      chatHistory?: ChatHistoryEntry[];
      agentMessages?: SessionSnapshot["agentMessages"];
    };

    if (Array.isArray(state.sessions)) {
      for (const snap of state.sessions) {
        if (!snap || typeof snap.id !== "string") continue;
        this.sessions.push(ChatSession.fromSnapshot(this.app, this.settings, snap));
      }
      if (state.activeSessionId && this.get(state.activeSessionId)) {
        this.activeId = state.activeSessionId;
      }
      this.evict();
      return;
    }

    // v1: a single unnamed conversation.
    if (Array.isArray(state.chatHistory) || Array.isArray(state.agentMessages)) {
      const session = new ChatSession(this.app, this.settings);
      session.chatHistory = Array.isArray(state.chatHistory) ? state.chatHistory : [];
      if (Array.isArray(state.agentMessages)) {
        session.agent.importMessages(state.agentMessages);
      }
      const firstUser = session.chatHistory.find((m) => m.type === "user" && m.text);
      if (firstUser?.text) session.maybeTitleFrom(firstUser.text);
      this.sessions.push(session);
      this.activeId = session.id;
    }
  }
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return items[i];
  return undefined;
}
