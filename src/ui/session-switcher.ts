import { SuggestModal } from "obsidian";
import type ChatPlugin from "../main";
import type { ChatSession } from "../types";

/** "just now", "12m ago", "3h ago", "5d ago" */
function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** The last thing said in a session, for disambiguating similar titles. */
function preview(session: ChatSession): string {
  for (let i = session.uiMessages.length - 1; i >= 0; i--) {
    const msg = session.uiMessages[i];
    if ((msg.type === "assistant" || msg.type === "user") && msg.text) {
      return msg.text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/**
 * Pick a conversation to switch to.
 *
 * This is the primary way to reach a session, because Obsidian's sidebar tab
 * bar renders icons only — every chat pane shows the same `message-circle`, so
 * the titles from `getDisplayText()` do not distinguish them there. It also
 * reaches sessions with no open pane at all, which are otherwise unreachable.
 */
export class SessionSwitcherModal extends SuggestModal<ChatSession> {
  private plugin: ChatPlugin;

  constructor(plugin: ChatPlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.setPlaceholder("Switch to a chat…");
    this.emptyStateText = "No chats yet.";
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "switch to chat" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): ChatSession[] {
    // Already sorted most-recently-updated first by the store.
    const sessions = this.plugin.sessions.list();
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;

    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        preview(session).toLowerCase().includes(needle)
    );
  }

  renderSuggestion(session: ChatSession, el: HTMLElement): void {
    el.addClass("ochat-session-item");

    const titleRow = el.createDiv({ cls: "ochat-session-item-title" });
    titleRow.createSpan({ text: session.title });

    const status = this.statusLabel(session);
    if (status) {
      titleRow.createSpan({ cls: "ochat-session-item-status", text: status });
    }

    const meta: string[] = [relativeTime(session.updatedAt)];
    if (this.plugin.isSessionOpen(session.id)) meta.push("open");

    const text = preview(session);
    if (text) meta.push(text);

    el.createDiv({ cls: "ochat-session-item-meta", text: meta.join(" · ") });
  }

  private statusLabel(session: ChatSession): string {
    if (this.plugin.sessions.pendingQuestion(session.id)) return "waiting for you";
    if (this.plugin.sessions.isRunning(session.id)) return "running";
    return "";
  }

  onChooseSuggestion(session: ChatSession): void {
    void this.plugin.revealSession(session.id);
  }
}
