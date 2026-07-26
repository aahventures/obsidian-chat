import { ItemView, Notice, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import { mount, unmount } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ChatSession, SelectionScope, SessionEvent } from "../types";
import { getModelDisplayName } from "../settings";

export const VIEW_TYPE_CHAT = "ochat-view";

/**
 * Chat view for Obsidian Chat.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 *
 * The view is a window onto a session owned by `plugin.sessions` — it holds no
 * conversation state of its own. Turns are run by the store, so closing the
 * view does not interrupt one, and reopening replays whatever happened while
 * it was gone.
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ReturnType<typeof ChatContainer> | undefined;
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Maps a tool_use id to the message row rendering it. */
  private toolRows = new Map<string, number>();
  /** Resolves once the Svelte component is mounted and ready for input. */
  private readyResolve: (() => void) | null = null;
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
    const session = this.sessionId ? this.plugin.sessions.get(this.sessionId) : null;
    return session?.title || "Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  /** Which session this pane is showing. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Make the tab header re-read `getDisplayText()`.
   *
   * `updateHeader()` exists at runtime but is not in Obsidian's public
   * typings, so it is called optionally — a stale tab title is a cosmetic
   * problem, and not worth risking a crash over if it ever goes away.
   */
  private refreshHeader(): void {
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
  }

  /**
   * Persisted into the workspace layout, so a pane comes back to the same
   * conversation after a restart or when dragged into a pop-out window.
   */
  getState(): Record<string, unknown> {
    return { sessionId: this.sessionId };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const requested = (state as { sessionId?: unknown } | null)?.sessionId;

    if (typeof requested === "string" && requested !== this.sessionId) {
      if (this.chatContainer) {
        // Already mounted — rebind live.
        this.bindTo(requested);
      } else {
        // Not mounted yet; onOpen will resolve this id (and fall back if the
        // session no longer exists, e.g. it was deleted before a restart).
        this.sessionId = requested;
      }
    }

    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    const session = this.resolveSession();
    this.sessionId = session.id;

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
      },
    });

    this.replay(session);
    this.unsubscribe = this.plugin.sessions.subscribe(session.id, (event) =>
      this.applyEvent(event)
    );
    this.refreshHeader();

    this.chatContainer.focus();
    this.readyResolve?.();
    this.readyResolve = null;
  }

  async onClose(): Promise<void> {
    // Deliberately does NOT abort the session: a run outlives its view, and
    // its results are replayed when a view binds to the session again.
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.chatContainer) {
      unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
    this.toolRows.clear();
  }

  /** Export the full transcript for sharing */
  getTranscript(): string {
    return this.sessionId ? this.plugin.sessions.transcript(this.sessionId) : "";
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

  // ─── Session binding ──────────────────────────────────────────────────────

  /** The session this view is showing, creating one if there is none yet. */
  private resolveSession(): ChatSession {
    if (this.sessionId) {
      const existing = this.plugin.sessions.get(this.sessionId);
      if (existing) return existing;
    }

    // No session, or the requested one is gone. Prefer a session no other pane
    // is already showing, so two panes don't end up mirroring one conversation.
    const taken = this.plugin.openSessionIds(this);
    const free = this.plugin.sessions.list().find((s) => !taken.has(s.id));
    return free ?? this.plugin.sessions.create();
  }

  /** Point this pane at a different session. */
  bindTo(sessionId: string): void {
    const session = this.plugin.sessions.get(sessionId);
    if (!session) return;

    this.unsubscribe?.();
    this.sessionId = sessionId;
    this.replay(session);
    this.unsubscribe = this.plugin.sessions.subscribe(sessionId, (event) =>
      this.applyEvent(event)
    );
    this.refreshHeader();
  }

  /** Rebuild the rendered conversation from the session's stored messages. */
  private replay(session: ChatSession): void {
    const chat = this.chatContainer;
    if (!chat) return;

    chat.clearMessages();
    this.toolRows.clear();

    for (const msg of session.uiMessages) {
      switch (msg.type) {
        case "user":
          chat.addUserMessage(msg.text ?? "");
          break;
        case "assistant":
          chat.addAssistantMessage(msg.text ?? "");
          break;
        case "tool-call": {
          if (!msg.toolName) break;
          const rowId = chat.addToolCall(msg.toolName, msg.toolInput ?? {});
          if (msg.toolId) this.toolRows.set(msg.toolId, rowId);
          // A call with no result was still in flight when this was stored.
          if (msg.toolResult) {
            chat.updateToolResult(rowId, msg.toolName, msg.toolResult);
          }
          break;
        }
        case "error":
          chat.addError(msg.text ?? "");
          break;
      }
    }

    const running = this.plugin.sessions.isRunning(session.id);
    chat.setInputEnabled(!running);
    if (running) chat.showThinking();

    // Re-present a question the agent is still parked on.
    if (this.plugin.sessions.pendingQuestion(session.id)) {
      chat.promptAnswer();
    }
  }

  /** Translate a session event into calls on the mounted component. */
  private applyEvent(event: SessionEvent): void {
    const chat = this.chatContainer;
    if (!chat) return;

    switch (event.kind) {
      case "message": {
        const msg = event.message;
        if (msg.type === "user") {
          chat.addUserMessage(msg.text ?? "");
        } else if (msg.type === "assistant") {
          chat.addAssistantMessage(msg.text ?? "");
        } else if (msg.type === "error") {
          chat.addError(msg.text ?? "");
        } else if (msg.type === "tool-call" && msg.toolName) {
          const rowId = chat.addToolCall(msg.toolName, msg.toolInput ?? {});
          if (msg.toolId) this.toolRows.set(msg.toolId, rowId);
        }
        break;
      }

      case "tool-result": {
        const rowId = this.toolRows.get(event.toolId);
        if (rowId !== undefined) {
          chat.updateToolResult(rowId, event.toolName, event.result);
        }
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
        if (!event.running) {
          chat.hideThinking();
          chat.setInputEnabled(true);
          chat.focus();
        } else {
          chat.setInputEnabled(false);
        }
        break;

      case "cleared":
        chat.clearMessages();
        this.toolRows.clear();
        break;

      case "title":
        // Retitle the tab header now the session has a real name.
        this.refreshHeader();
        break;
    }
  }

  // ─── Input handling ───────────────────────────────────────────────────────

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
    if (!this.sessionId) return;
    this.plugin.sessions.abort(this.sessionId);
  }

  private handleClear(): void {
    if (!this.sessionId) return;
    this.plugin.sessions.clearMessages(this.sessionId);
  }
}
