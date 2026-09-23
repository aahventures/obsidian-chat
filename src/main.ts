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
import { SessionStore } from "./sessions";

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /**
   * Every open conversation. Each session owns its own AgentLoop, so
   * switching chats swaps the agent state too rather than replaying one
   * history through a shared loop.
   */
  sessions!: SessionStore;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.sessions = new SessionStore(this.app, this.settings);
    this.sessions.onChange = () => void this.saveChatHistory();
    this.sessions.isOpen = (id) => this.isSessionOpen(id);

    // Restore persisted chat history
    await this.loadChatHistory();

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
          item.setTitle("New chat").setIcon("plus").onClick(() => this.newChat())
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
      id: "new-chat",
      name: "New chat",
      callback: () => this.newChat(),
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
    // The only place turns are stopped wholesale. Closing a view doesn't.
    this.sessions.abortAll();
    await this.saveChatHistory();
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
   * Note-driven entry points start their own conversation rather than
   * appending to whatever was already open — asking about a note should not
   * hijack an unrelated thread in progress.
   */
  private async openChatWithMessage(message: string): Promise<void> {
    const view = await this.newChat();
    if (view) {
      await view.whenReady;
      view.sendMessage(message);
    }
  }

  /**
   * Scope the CURRENT conversation to a selection; the user types their own
   * question next. Quoting a passage into the chat you're already in is how
   * chat apps behave, and "New chat" first gives a clean slate if wanted.
   */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    const view = await this.activateView();
    if (view) {
      await view.whenReady;
      view.setSelection(selection);
      view.focus();
    }
  }

  /**
   * Start a fresh conversation in `target` (the pane whose New button was
   * pressed), else the chat pane in focus, else a new pane. Existing sessions
   * keep their history and are reachable from the switcher. A pane that is
   * already on an untouched chat is reused, so pressing New twice doesn't
   * stack up blank sessions.
   */
  async newChat(target?: ObsidianChatView): Promise<ObsidianChatView | null> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return null;
    }
    const pane = target ?? this.getChatView();
    const current = pane?.getSessionId();
    if (pane && current && this.sessions.get(current)?.isEmpty) {
      this.app.workspace.revealLeaf(pane.leaf);
      pane.focus();
      return pane;
    }
    const session = this.sessions.create();
    return this.revealSession(session.id, pane ?? undefined);
  }

  private chatAboutActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  // ─── Panes ────────────────────────────────────────────────────────────

  /**
   * Sessions requested for leaves that are being opened, handed to the view's
   * onOpen() so it binds straight to the right one instead of picking a
   * session and being corrected by setState() a moment later.
   */
  private requestedSessions = new WeakMap<WorkspaceLeaf, string>();

  takeRequestedSession(leaf: WorkspaceLeaf): string | null {
    const id = this.requestedSessions.get(leaf) ?? null;
    this.requestedSessions.delete(leaf);
    return id;
  }

  /**
   * Reveal the pane showing `sessionId`, or open one. With no session given,
   * show the pane with the most recently used session.
   *
   * New panes always go in the right sidebar, on desktop and mobile, so a new
   * chat lands somewhere predictable. Users can still drag a pane to the main
   * area, split it, or pop it out, and each pane keeps its own session.
   */
  private async activateView(sessionId?: string): Promise<ObsidianChatView | null> {
    const { workspace } = this.app;

    const existing = sessionId
      ? this.findLeafForSession(sessionId)
      : this.mostRecentChatLeaf();
    if (existing) {
      workspace.revealLeaf(existing);
      // Views load deferred since 1.7.2. Force it, so callers awaiting
      // whenReady can't block on a view whose onOpen never runs.
      await existing.loadIfDeferred();
      return existing.view instanceof ObsidianChatView ? existing.view : null;
    }

    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return null;
    if (sessionId) this.requestedSessions.set(leaf, sessionId);
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
   * Bring a session on screen: reveal the pane already showing it, else point
   * `preferred` (or the chat pane in focus) at it, else open a pane.
   *
   * Pointing an open pane at it, rather than always opening another, keeps
   * sessions reachable without panes piling up, and two panes never end up on
   * the same conversation because an existing one is revealed instead.
   */
  async revealSession(
    sessionId: string,
    preferred?: ObsidianChatView
  ): Promise<ObsidianChatView | null> {
    if (!this.sessions.get(sessionId)) {
      new Notice("That chat no longer exists.");
      return null;
    }

    const existing = this.findLeafForSession(sessionId);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      await existing.loadIfDeferred();
      return existing.view instanceof ObsidianChatView ? existing.view : null;
    }

    // A pane that has since been closed doesn't count.
    const pane =
      preferred && this.getChatViews().includes(preferred) ? preferred : this.getChatView();
    if (pane) {
      this.app.workspace.revealLeaf(pane.leaf);
      pane.bindTo(sessionId);
      // getState() is what saves the binding, so ask for a layout save or a
      // restart would bring the pane back on its previous session.
      this.app.workspace.requestSaveLayout();
      pane.focus();
      void this.saveChatHistory();
      return pane;
    }

    return this.activateView(sessionId);
  }

  /**
   * The session a chat leaf shows. Reads the saved view state for a leaf
   * whose view hasn't loaded yet, since deferred panes still own a session.
   */
  private sessionIdOf(leaf: WorkspaceLeaf): string | null {
    if (leaf.view instanceof ObsidianChatView) return leaf.view.getSessionId();
    const id = (leaf.getViewState().state as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof id === "string" ? id : null;
  }

  private findLeafForSession(sessionId: string): WorkspaceLeaf | null {
    return (
      this.app.workspace
        .getLeavesOfType(VIEW_TYPE_CHAT)
        .find((leaf) => this.sessionIdOf(leaf) === sessionId) ?? null
    );
  }

  /** Whether some pane, loaded or deferred, shows this session. */
  isSessionOpen(sessionId: string): boolean {
    return this.findLeafForSession(sessionId) !== null;
  }

  /** Sessions shown by some pane, optionally ignoring one view. */
  openSessionIds(except?: ObsidianChatView): Set<string> {
    const ids = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      if (except && leaf.view === except) continue;
      const id = this.sessionIdOf(leaf);
      if (id) ids.add(id);
    }
    return ids;
  }

  /** The chat pane showing the most recently used session. */
  private mostRecentChatLeaf(): WorkspaceLeaf | null {
    let best: WorkspaceLeaf | null = null;
    let bestUpdated = -Infinity;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)) {
      const id = this.sessionIdOf(leaf);
      const updated = (id ? this.sessions.get(id)?.updatedAt : undefined) ?? 0;
      if (best === null || updated > bestUpdated) {
        best = leaf;
        bestUpdated = updated;
      }
    }
    return best;
  }

  /** The chat pane in focus, else any loaded one. */
  private getChatView(): ObsidianChatView | null {
    const active = this.app.workspace.getActiveViewOfType(ObsidianChatView);
    if (active) return active;
    return this.getChatViews()[0] ?? null;
  }

  /** Every loaded chat pane. */
  private getChatViews(): ObsidianChatView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE_CHAT)
      .map((leaf) => leaf.view)
      .filter((view): view is ObsidianChatView => view instanceof ObsidianChatView);
  }

  /**
   * The pane a destructive command should act on, or null if that would be a
   * guess. With several panes open and focus in a note, the first pane in
   * layout order is rarely the conversation in front of you, so only a
   * focused pane, or the only one, counts.
   */
  private getTargetForDestructiveCommand(): ObsidianChatView | null {
    const active = this.app.workspace.getActiveViewOfType(ObsidianChatView);
    if (active) return active;
    const open = this.getChatViews();
    return open.length === 1 ? open[0] : null;
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

  /**
   * Empty the current conversation in place. This keeps the session (and its
   * position in the switcher) rather than deleting it, which is what the
   * command has always meant.
   */
  private clearChat(): void {
    const view = this.getTargetForDestructiveCommand();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("Focus the chat you want to clear.");
    }
  }

  // ─── Chat history persistence ─────────────────────────────────────────

  async saveChatHistory(): Promise<void> {
    try {
      const state = this.sessions.toPersisted();
      await this.app.vault.adapter.write(
        ".obsidian/plugins/obsidian-chat/chat-state.json",
        JSON.stringify(state)
      );
    } catch {
      // Persistence is best-effort
    }
  }

  private async loadChatHistory(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(
        ".obsidian/plugins/obsidian-chat/chat-state.json"
      );
      // Handles both the multi-session shape and the older single
      // conversation, which is migrated into one session.
      this.sessions.restore(JSON.parse(raw));
    } catch {
      // No saved state or parse error — start fresh
    }
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

    // Update every chat pane's header with the new model name
    const modelName = getModelDisplayName(this.settings.provider, this.settings.model);
    for (const view of this.getChatViews()) view.updateModel(modelName);
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
