import { ItemView, WorkspaceLeaf, Notice, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ChatSession } from "../sessions";
import type { SelectionScope, SessionEvent } from "../types";
import { getModelDisplayName } from "../settings";

export const VIEW_TYPE_CHAT = "ochat-view";

/**
 * Chat view for Obsidian Chat.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 *
 * Each pane shows one session, owned by `plugin.sessions`, and holds no
 * conversation state of its own. Turns are run by the store, so closing a pane
 * or pointing it at another session doesn't interrupt one, and showing that
 * session again replays whatever happened in the meantime. The pane persists
 * which session it shows through getState()/setState(), so tabs, splits and
 * pop-out windows come back to the same conversation after a restart.
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ReturnType<typeof ChatContainer> | undefined;
  /** The session on screen. */
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Maps a tool_use id to the row rendering it. */
  private toolRows = new Map<string, number>();
  private readyResolve: (() => void) | null = null;
  /** Resolves once the component is mounted and bound to a session. */
  readonly whenReady: Promise<void>;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.whenReady = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    const session = this.sessionId ? this.plugin.sessions.get(this.sessionId) : undefined;
    return session?.title || "Chat";
  }

  /** Which session this pane shows. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  getState(): Record<string, unknown> {
    return { sessionId: this.sessionId };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const requested = (state as { sessionId?: unknown } | null)?.sessionId;
    if (typeof requested === "string" && requested !== this.sessionId) {
      if (this.chatContainer) this.bindTo(requested);
      else this.sessionId = requested; // onOpen picks it up
    }
    await super.setState(state, result);
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    this.sessionId ??= this.plugin.takeRequestedSession(this.leaf);
    const session = this.resolveSession();

    const container = this.contentEl;
    container.empty();
    container.addClass("ochat-view-container");

    this.chatContainer = mount(ChatContainer, {
      target: container,
      props: {
        app: this.app,
        component: this,
        provider: this.plugin.settings.provider,
        model: getModelDisplayName(this.plugin.settings.provider, this.plugin.settings.model),
        onSend: (text: string, selection: SelectionScope | null) =>
          this.handleUserMessage(text, selection),
        onClear: () => this.handleClear(),
        onStop: () => this.handleStop(),
        onNewSession: () => void this.plugin.newChat(this),
        onSelectSession: (id: string) => void this.plugin.revealSession(id, this),
        // Sessions change outside this pane too (created, discarded, deleted,
        // renamed elsewhere), so refresh the list whenever it's opened.
        onRefreshSessions: () => this.refreshSwitcher(),
      },
    });

    this.sessionId = null; // so bindTo() doesn't treat it as already bound
    this.bindTo(session.id);
    this.readyResolve?.();
    this.readyResolve = null;
  }

  /**
   * The session to show when the pane opens: the one it was given, else one
   * no other pane is showing (so two panes don't mirror one conversation),
   * else a new one.
   */
  private resolveSession(): ChatSession {
    const given = this.sessionId ? this.plugin.sessions.get(this.sessionId) : undefined;
    if (given) return given;
    const taken = this.plugin.openSessionIds(this);
    return this.plugin.sessions.list().find((s) => !taken.has(s.id)) ?? this.plugin.sessions.create();
  }

  /**
   * Point this pane at a session: repaint its transcript and listen for what it
   * does next. Allowed mid-turn, since the turn belongs to the session and keeps
   * running while no pane shows it.
   */
  bindTo(sessionId: string): void {
    const session = this.plugin.sessions.get(sessionId);
    if (!session || !this.chatContainer) return;
    this.unsubscribe?.();
    this.sessionId = sessionId;
    this.replay(session);
    this.refreshSwitcher();
    this.unsubscribe = this.plugin.sessions.subscribe(sessionId, (event) =>
      this.applyEvent(event)
    );
    this.refreshHeader();
  }

  /**
   * Make the tab re-read getDisplayText(). `updateHeader()` exists at runtime
   * but isn't in Obsidian's public typings, so it's called optionally: a stale
   * tab title is cosmetic, and not worth crashing over if it ever goes away.
   */
  private refreshHeader(): void {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }

  async onClose(): Promise<void> {
    // Deliberately doesn't stop the session: a turn outlives its view.
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.chatContainer) {
      unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
    this.toolRows.clear();
    // An untouched "New chat" that only this pane showed isn't worth keeping.
    if (this.sessionId) this.plugin.discardIfAbandoned(this.sessionId, this);
  }

  /** Export the full transcript for debugging */
  getTranscript(): string {
    const session = this.sessionId ? this.plugin.sessions.get(this.sessionId) : undefined;
    return session?.agent.exportTranscript() ?? "";
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  /** Set the selection scope and show the pill */
  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  /** Focus the input */
  focus(): void {
    this.chatContainer?.focus();
  }

  /** Update the model display name in the header */
  updateModel(name: string): void {
    this.chatContainer?.setModel(name);
  }

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  private refreshSwitcher(): void {
    const session = this.sessionId ? this.plugin.sessions.get(this.sessionId) : undefined;
    this.chatContainer?.setTitle(session?.title ?? "Chat");
    this.chatContainer?.setSessions(
      this.plugin.sessions.list().map((s) => ({ id: s.id, title: s.title })),
      this.sessionId ?? ""
    );
  }

  /** Rebuild the rendered conversation from the session's history. */
  private replay(session: ChatSession): void {
    const chat = this.chatContainer;
    if (!chat) return;

    chat.clearMessages();
    // A half-typed draft belongs to the session it was typed in.
    chat.clearInput();
    this.toolRows.clear();

    for (const entry of session.chatHistory) {
      switch (entry.type) {
        case "user":
          chat.addUserMessage(entry.text ?? "");
          break;
        case "assistant":
          chat.addAssistantMessage(entry.text ?? "");
          break;
        case "tool-call":
        case "tool-result": {
          if (!entry.toolName) break;
          const row = chat.addToolCall(entry.toolName, entry.toolInput ?? {});
          if (entry.toolId) this.toolRows.set(entry.toolId, row);
          // A call with no result yet was still running when it was recorded.
          if (entry.toolResult) chat.updateToolResult(row, entry.toolName, entry.toolResult);
          break;
        }
        case "error":
          chat.addError(entry.text ?? "");
          break;
      }
    }

    chat.setInputEnabled(!session.running);
    if (session.running) chat.showThinking();
    if (session.pendingQuestion) chat.promptAnswer();
  }

  /** Mirror a session event onto the component. */
  private applyEvent(event: SessionEvent): void {
    const chat = this.chatContainer;
    if (!chat) return;

    switch (event.kind) {
      case "message": {
        const entry = event.entry;
        if (entry.type === "user") chat.addUserMessage(entry.text ?? "");
        else if (entry.type === "assistant") chat.addAssistantMessage(entry.text ?? "");
        else if (entry.type === "error") chat.addError(entry.text ?? "");
        else if (entry.type === "tool-call" && entry.toolName) {
          const row = chat.addToolCall(entry.toolName, entry.toolInput ?? {});
          if (entry.toolId) this.toolRows.set(entry.toolId, row);
        }
        break;
      }
      case "tool-result": {
        const row = this.toolRows.get(event.toolId);
        if (row !== undefined) chat.updateToolResult(row, event.toolName, event.result);
        break;
      }
      case "thinking":
        if (event.on) chat.showThinking();
        else chat.hideThinking();
        break;
      case "ask-user":
        chat.promptAnswer();
        break;
      case "running":
        if (event.running) {
          chat.setInputEnabled(false);
        } else {
          chat.hideThinking();
          chat.setInputEnabled(true);
          chat.focus();
        }
        break;
      case "cleared":
        chat.clearMessages();
        this.toolRows.clear();
        break;
      case "title":
        this.refreshSwitcher();
        this.refreshHeader();
        break;
    }
  }

  // ─── Input ────────────────────────────────────────────────────────────

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null
  ): Promise<void> {
    if (!this.sessionId) return;
    const outcome = await this.plugin.sessions.run(this.sessionId, text, selection);
    if (outcome === "busy") {
      new Notice("Please wait for the current response to complete.");
    }
  }

  private handleStop(): void {
    if (this.sessionId) this.plugin.sessions.abort(this.sessionId);
  }

  private handleClear(): void {
    if (this.sessionId) this.plugin.sessions.clearMessages(this.sessionId);
  }
}
