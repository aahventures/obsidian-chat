import { App } from "obsidian";
import type {
  AgentCallbacks,
  ChatSettings,
  ContextUsage,
  ChatHistoryEntry,
  SelectionScope,
  SessionEvent,
  SessionSnapshot,
  PersistedChatState,
} from "./types";
import { AgentLoop, isTurnStart } from "./agent/loop";
import { uniqueId } from "./util/id";

/** Cap on UI transcript entries kept per session when persisting. */
const MAX_HISTORY_PER_SESSION = 100;
/**
 * Cap on retained sessions, so `chat-state.json` can't grow forever.
 * Least-recently-used sessions are evicted first; a session a pane is
 * showing is never evicted.
 */
const MAX_SESSIONS = 20;

/** Longest auto-derived title before ellipsis. */
const MAX_TITLE_LENGTH = 40;

/** Shown for a session with no title yet. Display only: such a title is saved empty. */
const UNTITLED = "New chat";

/** How a trim notice starts, so a new trim replaces it and leaves other notices be. */
const TRIM_NOTICE = "History trimmed:";

type SessionListener = (event: SessionEvent) => void;

/**
 * One conversation: its own transcript, its own AgentLoop (and therefore its
 * own API message history and provider chaining state).
 */
export class ChatSession {
  readonly id: string;
  /** Empty until named, by the first message or by hand. Shown as `displayTitle`. */
  title = "";
  readonly createdAt: number;
  updatedAt: number;
  chatHistory: ChatHistoryEntry[] = [];
  readonly agent: AgentLoop;

  // Runtime only, never persisted.
  /**
   * Size of the latest request, for the context meter. Unknown until this
   * session sends one after a load: a saved number could be stale, since saves
   * cap the history.
   */
  context: ContextUsage | null = null;
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
    this.id = id ?? uniqueId("s");
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = this.createdAt;
    this.agent = new AgentLoop(app, settings);
  }

  get displayTitle(): string {
    return this.title || UNTITLED;
  }

  /**
   * Nothing has been said in this session, nothing is happening in it, and it
   * hasn't been named. A chat named before its first message is kept.
   */
  get isEmpty(): boolean {
    return this.chatHistory.length === 0 && !this.running && !this.askResolve && !this.title;
  }

  /**
   * Title the session from its first user message, once. Titles are derived
   * rather than model-generated so that opening a chat never costs a call.
   */
  maybeTitleFrom(text: string): void {
    if (this.title) return;
    const flat = text.replace(/\s+/g, " ").trim();
    if (!flat) return;
    this.title =
      flat.length > MAX_TITLE_LENGTH ? `${flat.slice(0, MAX_TITLE_LENGTH - 1)}…` : flat;
  }

  touch(): void {
    this.updatedAt = Date.now();
  }

  /**
   * Index of the first transcript entry the model can still see, or 0 if it
   * sees them all. Long chats drop their oldest turns from what is sent (see
   * AgentLoop.pruneHistory) while the transcript keeps showing them, so this
   * is where the view draws the line. Turns are matched newest first by the
   * user's text, which each sent turn ends with after its context block.
   * Answers to ask_user are tool results rather than turns, so they don't
   * match and are passed over.
   */
  get rememberedFrom(): number {
    // A summary covers everything before it, so the model has it all, in brief.
    if (!this.agent.sendsFullHistory || this.agent.startsFromSummary) return 0;
    const turns = this.agent
      .exportMessages()
      .filter(isTurnStart)
      .map((m) => m.content as string);
    let t = turns.length - 1;
    let first = -1;
    for (let i = this.chatHistory.length - 1; i >= 0 && t >= 0; i--) {
      const entry = this.chatHistory[i];
      if (entry.type !== "user" || !entry.text) continue;
      if (turns[t].endsWith(`\n\n${entry.text}`)) {
        first = i;
        t--;
      }
    }
    // Ran out of transcript first: its start was capped on save, so nothing
    // on screen is missing from what is sent.
    if (t >= 0 || first < 0) return 0;
    return this.chatHistory.slice(0, first).some((e) => e.type === "user") ? first : 0;
  }

  toSnapshot(): SessionSnapshot {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      chatHistory: this.chatHistory.slice(-MAX_HISTORY_PER_SESSION),
      // As is: it's what the next request sends, and the loop keeps it bounded
      // (trimmed, or compacted by Anthropic). A cut here would lose context
      // the model still had, or the summary standing in for the rest.
      agentMessages: this.agent.exportMessages(),
      openai: this.agent.exportOpenAIState(),
    };
  }

  static fromSnapshot(app: App, settings: ChatSettings, snap: SessionSnapshot): ChatSession {
    const session = new ChatSession(app, settings, snap.id, snap.createdAt);
    session.title = typeof snap.title === "string" ? snap.title : "";
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
 * Holds every conversation and runs their turns. Which pane shows which
 * session is the plugin's business, not the store's.
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
  /** Deleted here or on another device. Travels in the saved file. */
  private deletedIds = new Set<string>();
  /**
   * Dropped by the cap on this device. Not tombstones, since another device
   * may still want them, but a save mustn't write them straight back either.
   */
  private evictedIds = new Set<string>();

  /** Called whenever there is something worth saving. Set by the plugin. */
  onChange: () => void = () => {};
  /** Whether some pane is showing a session. Set by the plugin. */
  isOpen: (id: string) => boolean = () => false;

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
    this.append(session, selection ? { type: "user", text, selection } : { type: "user", text });

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
   * meant. The title goes back to empty so the next message names it,
   * instead of the switcher labeling it after the conversation just cleared.
   */
  clearMessages(id: string): void {
    const session = this.get(id);
    if (!session) return;
    this.stop(session);
    session.agent.clear();
    session.chatHistory = [];
    session.context = null;
    session.title = "";
    session.touch();
    this.emit(session, { kind: "title", title: session.title });
    this.emit(session, { kind: "cleared" });
    this.emit(session, { kind: "context" });
    this.emit(session, { kind: "running", running: false });
    this.onChange();
  }

  /**
   * Rename a session. Its place in the switcher stays, since a rename isn't
   * using the chat.
   */
  rename(id: string, name: string): void {
    const session = this.get(id);
    const title = name.replace(/\s+/g, " ").trim();
    // A blank name changes nothing, like Cancel.
    if (!session || !title || title === session.title) return;
    session.title = title;
    this.emit(session, { kind: "title", title: session.title });
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

      onSkillsNamed: (skills) => {
        // This turn's message: the last one yours, as the skills run before anything is asked.
        const entry = findLast(session.chatHistory, (e) => e.type === "user");
        if (!entry || skills.length === 0) return;
        entry.skills = skills;
        session.touch();
        this.emit(session, { kind: "user-skills", skills });
      },

      onTrim: (turns) => {
        // Only the latest trim is worth a line; the divider tracks the rest.
        session.chatHistory = session.chatHistory.filter(
          (e) => !(e.type === "notice" && e.text?.startsWith(TRIM_NOTICE))
        );
        const what = turns === 1 ? "message of yours is" : `messages of yours are`;
        this.append(session, {
          type: "notice",
          text: `${TRIM_NOTICE} ${turns === 1 ? "an" : turns} earlier ${what} no longer sent to the model.`,
        });
        this.emit(session, { kind: "trimmed" });
      },

      onCompacted: () => {
        this.emit(session, { kind: "thinking", on: false });
        this.append(session, {
          type: "notice",
          text: "Compacted: the model now has a summary of the conversation above in place of the full text.",
        });
      },

      onUsage: (usage, { provider, model }) => {
        // A response that searched the web reports the input of every search
        // step added together, which isn't the context's size. The last real
        // figure stands, marked as older than the search; it keeps its own
        // model, which the menu names. The next
        // response without a search brings a new figure.
        if (usage.multiStep) {
          if (session.context && !session.context.beforeSearch) {
            session.context = { ...session.context, beforeSearch: true };
            this.emit(session, { kind: "context" });
          }
          return;
        }
        const cached = usage.cacheReadTokens;
        session.context = {
          tokens: usage.inputTokens + (cached ?? 0) + (usage.cacheWriteTokens ?? 0),
          cachedTokens: cached,
          provider,
          model,
        };
        this.emit(session, { kind: "context" });
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

  get(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  create(): ChatSession {
    const session = new ChatSession(this.app, this.settings);
    this.sessions.push(session);
    this.evict();
    return session;
  }

  /** Remove a session for good, stopping its turn first. */
  delete(id: string): void {
    const session = this.get(id);
    if (!session) return;
    this.stop(session);
    session.listeners.clear();
    this.sessions = this.sessions.filter((s) => s !== session);
    this.deletedIds.add(id);
    this.onChange();
  }

  /**
   * Drop least-recently-used sessions past the cap. Never one a pane is
   * showing, and never one with a turn in progress.
   */
  private evict(): void {
    if (this.sessions.length <= MAX_SESSIONS) return;
    const keep = new Set(
      this.list()
        .slice(0, MAX_SESSIONS)
        .map((s) => s.id)
    );
    const kept = this.sessions.filter((s) => keep.has(s.id) || s.running || this.isOpen(s.id));
    for (const s of this.sessions) if (!kept.includes(s)) this.evictedIds.add(s.id);
    this.sessions = kept;
  }

  /**
   * What to write to disk, merged with what's there now (`onDisk`).
   *
   * The file lives in the plugin folder, which syncs between devices. So keep
   * any session another device wrote that this one doesn't hold, or saving here
   * would delete it. Sessions this device holds are its to overwrite, so the
   * same conversation edited on two devices at once is still last write wins.
   * Deletes travel as tombstones, which are kept rather than expired: there's
   * no knowing when the last device holding a copy has stopped, and they're
   * only ids.
   */
  toPersisted(onDisk?: unknown): PersistedChatState {
    const disk = asPersisted(onDisk);
    for (const id of disk?.deleted ?? []) this.deletedIds.add(id);

    // An unused "New chat" isn't worth saving: every press of the command would
    // leave a permanent untitled entry in the switcher. One a pane is showing
    // is kept though, or that pane would lose its session across a restart.
    const ours = this.list()
      .filter((s) => !this.deletedIds.has(s.id))
      .filter((s) => !s.isEmpty || this.isOpen(s.id))
      .map((s) => s.toSnapshot());
    const known = new Set([...this.sessions.map((s) => s.id), ...this.evictedIds]);
    const theirs = (disk?.sessions ?? []).filter(
      (s) => !known.has(s.id) && !this.deletedIds.has(s.id)
    );
    const sessions = [...ours, ...theirs].sort((a, b) => b.updatedAt - a.updatedAt);

    return {
      version: 3,
      // Panes remember their own session now. This only tells an older version
      // of the plugin which chat to show if someone downgrades.
      activeSessionId: sessions[0]?.id ?? null,
      sessions,
      deleted: [...this.deletedIds],
    };
  }

  /**
   * Restore from disk. Accepts the pre-multi-session shape
   * (`{ chatHistory, agentMessages }`) and migrates it into a single session,
   * so an upgrade never loses the conversation in progress.
   */
  restore(raw: unknown): void {
    this.sessions = [];
    if (!raw || typeof raw !== "object") return;
    const state = raw as Partial<PersistedChatState> & {
      chatHistory?: ChatHistoryEntry[];
      agentMessages?: SessionSnapshot["agentMessages"];
    };

    for (const id of Array.isArray(state.deleted) ? state.deleted : []) {
      if (typeof id === "string") this.deletedIds.add(id);
    }

    if (Array.isArray(state.sessions)) {
      for (const snap of fromLegacyTitles(state.version, state.sessions)) {
        if (!snap || typeof snap.id !== "string" || this.deletedIds.has(snap.id)) continue;
        this.sessions.push(ChatSession.fromSnapshot(this.app, this.settings, snap));
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
    }
  }
}

function findLast<T>(items: T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return items[i];
  return undefined;
}

/** The multi-session file shape, or null for anything else. */
function asPersisted(raw: unknown): PersistedChatState | null {
  const state = raw as Partial<PersistedChatState> | null;
  if (!state || typeof state !== "object" || !Array.isArray(state.sessions)) return null;
  return {
    version: 3,
    activeSessionId: null,
    sessions: fromLegacyTitles(
      state.version,
      state.sessions.filter((s): s is SessionSnapshot => !!s && typeof s.id === "string")
    ),
    deleted: Array.isArray(state.deleted)
      ? state.deleted.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * Files before version 3, written by an older version of the plugin here or on
 * another device, save an untitled session as "New chat". Nobody could name a
 * chat then, so that title is the placeholder, and reads as untitled.
 */
function fromLegacyTitles(version: unknown, sessions: SessionSnapshot[]): SessionSnapshot[] {
  if (version === 3) return sessions;
  return sessions.map((s) => (s?.title === UNTITLED ? { ...s, title: "" } : s));
}

/**
 * Convert `chat-sessions.json`, written by a fork of this plugin that had
 * sessions first, into the `chat-state.json` shape. Its transcript entries
 * already match ChatHistoryEntry. Returns null if it isn't that file.
 */
export function fromForkSessionsFile(raw: unknown): PersistedChatState | null {
  const file = raw as { sessions?: unknown[]; deleted?: unknown[] } | null;
  if (!file || !Array.isArray(file.sessions)) return null;
  const sessions: SessionSnapshot[] = [];
  for (const item of file.sessions) {
    const s = item as Record<string, unknown> | null;
    if (!s || typeof s.id !== "string" || !s.id) continue;
    const now = Date.now();
    sessions.push({
      id: s.id,
      title: typeof s.title === "string" && s.title ? s.title : UNTITLED,
      createdAt: typeof s.createdAt === "number" ? s.createdAt : now,
      updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : now,
      chatHistory: Array.isArray(s.uiMessages) ? (s.uiMessages as ChatHistoryEntry[]) : [],
      agentMessages: Array.isArray(s.agentMessages)
        ? (s.agentMessages as SessionSnapshot["agentMessages"])
        : [],
      // That fork never restored a chain id, so start unchained.
      openai: { previousResponseId: null },
    });
  }
  return {
    version: 2,
    activeSessionId: null,
    sessions,
    deleted: (file.deleted ?? []).filter((id): id is string => typeof id === "string"),
  };
}
