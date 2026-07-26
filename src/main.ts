import {
  Plugin,
  Platform,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
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

  /** Open chat and immediately send a message */
  private async openChatWithMessage(message: string): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    await this.activateView();
    const view = this.getChatView();
    if (view) {
      // Wait for the Svelte component to mount rather than guessing at a delay.
      await view.whenReady;
      view.sendMessage(message);
    }
  }

  /** Open chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    if (!this.settings.apiKey) {
      new Notice("Please configure your API key in Obsidian Chat settings.");
      return;
    }
    await this.activateView();
    const view = this.getChatView();
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

  /** Open or reveal the chat view in the right sidebar (both desktop and mobile). */
  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]);
      // Views load deferred since v1.7.2; force it so callers awaiting
      // `whenReady` cannot block on a view whose onOpen never ran.
      await existing[0].loadIfDeferred();
      return;
    }

    // Right sidebar on both desktop and mobile.
    // On mobile, this slides in as a panel from the right edge.
    const leaf = workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      workspace.revealLeaf(leaf);
      await leaf.loadIfDeferred();
    }
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
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
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
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

    // Update the chat view header with the new model name
    this.getChatView()?.updateModel(
      getModelDisplayName(this.settings.provider, this.settings.model)
    );
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
