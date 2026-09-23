import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
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
 * The view is a window onto a session owned by `plugin.sessions` and holds no
 * conversation state of its own. Turns are run by the store, so closing the
 * view or switching sessions doesn't interrupt one, and showing that session
 * again replays whatever happened in the meantime.
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ReturnType<typeof ChatContainer> | undefined;
  /** The session on screen. */
  private sessionId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Maps a tool_use id to the row rendering it. */
  private toolRows = new Map<string, number>();

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
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
        onNewSession: () => this.plugin.newChat(),
        onSelectSession: (id: string) => this.switchSession(id),
      },
    });

    this.renderActiveSession();
  }

  /**
   * Show the active session: repaint its transcript, refresh the switcher, and
   * listen for what it does next. Called on open and on every session change.
   */
  renderActiveSession(): void {
    const chat = this.chatContainer;
    if (!chat) return;

    const session = this.plugin.sessions.active();
    this.unsubscribe?.();
    this.sessionId = session.id;
    this.refreshSwitcher();
    this.replay(session);
    this.unsubscribe = this.plugin.sessions.subscribe(session.id, (event) =>
      this.applyEvent(event)
    );
  }

  /**
   * Switch which session the view shows. Allowed mid-turn: the turn belongs to
   * its session, not to the view, and keeps running while switched away.
   */
  private switchSession(id: string): void {
    if (!this.plugin.sessions.setActive(id)) return;
    this.renderActiveSession();
    void this.plugin.saveChatHistory();
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
  }

  /** Export the full transcript for debugging */
  getTranscript(): string {
    return this.plugin.sessions.active().agent.exportTranscript();
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
