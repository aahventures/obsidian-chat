import { SuggestModal } from "obsidian";
import type ChatPlugin from "../main";
import type { ChatSession } from "../sessions";

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

/** The last thing said in a session, for telling similar titles apart. */
function preview(session: ChatSession): string {
  for (let i = session.chatHistory.length - 1; i >= 0; i--) {
    const entry = session.chatHistory[i];
    if ((entry.type === "assistant" || entry.type === "user") && entry.text) {
      return entry.text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

/**
 * Pick a conversation to switch to, with search, status and the last message.
 * The header dropdown is the quick way to switch; this is for finding a chat
 * by what was said in it, or seeing which ones are running or waiting on you.
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
    // Already most recently used first.
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

    const status = statusLabel(session);
    if (status) {
      titleRow.createSpan({ cls: "ochat-session-item-status", text: status });
    }

    const meta: string[] = [relativeTime(session.updatedAt)];
    if (this.plugin.isSessionOpen(session.id)) meta.push("open");

    const text = preview(session);
    if (text) meta.push(text);

    el.createDiv({ cls: "ochat-session-item-meta", text: meta.join(" · ") });
  }

  onChooseSuggestion(session: ChatSession): void {
    void this.plugin.revealSession(session.id);
  }
}

function statusLabel(session: ChatSession): string {
  if (session.pendingQuestion) return "waiting for you";
  if (session.running) return "running";
  return "";
}
