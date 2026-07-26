import {
  Plugin,
  Platform,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
  type WorkspaceLeaf,
} from "obsidian";
import type { ChatSettings, SelectionScope } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { ChatSettingTab, getModelDisplayName } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { SessionStore } from "./agent/sessions";

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /**
   * Owns every conversation and runs their turns. Lives on the plugin so a run
   * survives its view being closed.
   */
  sessions!: SessionStore;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.sessions = new SessionStore(this.app, this.settings);

    // Restore persisted sessions (migrating pre-session state if present)
    await this.sessions.load();

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Obsidian Chat", (evt) => {
      if (evt.type === "contextmenu" || (evt instanceof MouseEvent && evt.button === 2)) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New chat").setIcon("plus").onClick(() => {
            void this.newChat();
          })
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt as MouseEvent);
      } else {
        this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => this.openChat(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: () => {
        void this.newChat();
      },
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    this.addCommand({
      id: "delete-chat",
      name: "Delete this chat",
      callback: () => this.deleteCurrentChat(),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to Chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope: SelectionScope = { text: sel, filePath: ctx.file?.path ?? "" };
        this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Chat about this note")
            .setIcon("message-circle")
            .onClick(() => this.openChatWithMessage(`Tell me about ${file.path}`))
        );
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle("Send selection to Chat")
              .setIcon("message-circle")
              .onClick(() => {
                const scope: SelectionScope = { text: sel, filePath: info.file?.path ?? "" };
                this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  async onunload(): Promise<void> {
    // Unload is the only place runs are stopped wholesale — closing a view
    // leaves its session running.
    this.sessions.abortAll();
    await this.sessions.save();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
  }

  // ─── Chat operations ────────────────────────────────────────────────

  private async openChat(): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    await this.activateView();
  }

  /**
   * Open a NEW conversation and immediately send a message.
   *
   * Starting fresh rather than appending is deliberate: asking about a note
   * should not inherit whatever unrelated context the last conversation had.
   */
  private async openChatWithMessage(message: string): Promise<void> {
    const view = await this.newChat();
    if (view) {
      // Wait for the Svelte component to mount rather than guessing at a delay.
      await view.whenReady;
      view.sendMessage(message);
    }
  }

  /** Open a NEW conversation scoped to a selection (user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    const view = await this.newChat();
    if (view) {
      await view.whenReady;
      view.setSelection(selection);
      view.focus();
    }
  }

  private chatAboutActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /**
   * Reveal the pane showing `sessionId`, or open one.
   *
   * The first chat pane goes in the right sidebar, preserving existing
   * behaviour and keeping mobile sensible. Additional sessions open as
   * workspace tabs, which is what makes splitting and popping out work.
   */
  private async activateView(sessionId?: string): Promise<ObsidianChatView | null> {
    const { workspace } = this.app;

    if (sessionId) {
      const existing = this.findLeafForSession(sessionId);
      if (existing) {
        workspace.revealLeaf(existing);
        // Views load deferred since v1.7.2; force it so callers awaiting
        // `whenReady` cannot block on a view whose onOpen never ran.
        await existing.loadIfDeferred();
        return existing.view instanceof ObsidianChatView ? existing.view : null;
      }
    }

    const chatLeaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    // Reuse the only pane when no particular session was asked for.
    if (!sessionId && chatLeaves.length > 0) {
      workspace.revealLeaf(chatLeaves[0]);
      await chatLeaves[0].loadIfDeferred();
      return chatLeaves[0].view instanceof ObsidianChatView ? chatLeaves[0].view : null;
    }

    const leaf =
      chatLeaves.length === 0 ? workspace.getRightLeaf(false) : workspace.getLeaf("tab");
    if (!leaf) return null;

    await leaf.setViewState({
      type: VIEW_TYPE_CHAT,
      active: true,
      state: sessionId ? { sessionId } : undefined,
    });
    workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred();
    return leaf.view instanceof ObsidianChatView ? leaf.view : null;
  }

  /**
   * The leaf showing a session, if one is open.
   *
   * Reads the leaf's view state rather than the view object so it works for
   * deferred leaves that have not been constructed yet.
   */
  private findLeafForSession(sessionId: string): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      const view = leaf.view;
      if (view instanceof ObsidianChatView && view.getSessionId() === sessionId) {
        return leaf;
      }
      const state = leaf.getViewState().state as { sessionId?: unknown } | undefined;
      if (state?.sessionId === sessionId) return leaf;
    }
    return null;
  }

  /** Sessions currently displayed by some pane, optionally ignoring one view. */
  openSessionIds(except?: ObsidianChatView): Set<string> {
    const ids = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      const view = leaf.view;
      if (view instanceof ObsidianChatView && view !== except) {
        const id = view.getSessionId();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  /** Start a fresh conversation in its own pane. */
  async newChat(): Promise<ObsidianChatView | null> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return null;
    }
    const session = this.sessions.create();
    return this.activateView(session.id);
  }

  /**
   * The pane a destructive command should act on, or null if it would be a
   * guess.
   *
   * `getChatView()` falls back to the first chat leaf in layout order, which is
   * fine for "show me a chat" but not for deleting one: with several panes open
   * and focus in the editor, the first leaf is rarely the conversation in front
   * of you, and delete has no undo. A lone chat pane is still unambiguous, so
   * the common case keeps working.
   */
  private getTargetForDestructiveCommand(): ObsidianChatView | null {
    const active = this.app.workspace.getActiveViewOfType(ObsidianChatView);
    if (active) return active;
    const open = this.getChatViews();
    return open.length === 1 ? open[0] : null;
  }

  /** Get the chat view the user is looking at, else any open one. */
  private getChatView(): ObsidianChatView | null {
    const active = this.app.workspace.getActiveViewOfType(ObsidianChatView);
    if (active) return active;

    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  /** Every open chat view. */
  private getChatViews(): ObsidianChatView[] {
    const views: ObsidianChatView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      if (leaf.view instanceof ObsidianChatView) views.push(leaf.view);
    }
    return views;
  }

  private shareTranscript(): void {
    const view = this.getChatView();
    if (!view) {
      new Notice("No active conversation.");
      return;
    }

    const transcript = view.getTranscript();
    if (!transcript || transcript.endsWith("## Conversation\n\n")) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(transcript).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  private clearChat(): void {
    const view = this.getTargetForDestructiveCommand();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("Focus the chat you want to clear.");
    }
  }

  /** Delete the current conversation and close the pane showing it. */
  private deleteCurrentChat(): void {
    const view = this.getTargetForDestructiveCommand();
    const sessionId = view?.getSessionId();
    if (!view || !sessionId) {
      new Notice("Focus the chat you want to delete.");
      return;
    }

    const title = this.sessions.get(sessionId)?.title ?? "chat";
    this.sessions.delete(sessionId);
    view.leaf.detach();
    new Notice(`Deleted "${title}".`);
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_SETTINGS.model;
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");

    // Save all other settings to data.json (syncs), but strip the API key
    const toSave = { ...this.settings, apiKey: "" };
    await this.saveData(toSave);

    // Update every open chat pane's header with the new model name
    const modelName = getModelDisplayName(this.settings.provider, this.settings.model);
    for (const view of this.getChatViews()) {
      view.updateModel(modelName);
    }
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  private loadApiKey(provider: string): string {
    try {
      return this.app.secretStorage.getSecret(`obsidian-chat-api-key-${provider}`) || "";
    } catch {
      return "";
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`obsidian-chat-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }
}
