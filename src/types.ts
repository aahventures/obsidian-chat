// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "custom";

export interface ChatSettings {
  provider: Provider;
  apiKey: string;
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  baseUrl: string;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-6",
  maxIterations: 20,
  enableWebSearch: true,
  baseUrl: "",
};

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface UnifiedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── API Response ───────────────────────────────────────────────────────────

export interface UnifiedResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | string;
  usage?: {
    /** Uncached input only. Total input is this plus the two cache counts. */
    inputTokens: number;
    outputTokens: number;
    /** Anthropic only: input served from cache (billed at about 0.1x). */
    cacheReadTokens?: number;
    /** Anthropic only: input written to cache (billed at about 1.25x). */
    cacheWriteTokens?: number;
  };
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  activeFileContent: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
  /**
   * The vault path the tool acted on, when it acted on exactly one file.
   *
   * Rendered as a link in the chat so a result can be navigated back to. It is
   * resolved by the executor rather than read off the tool input, because the
   * tools that fall back to the active document have no path in their input.
   */
  path?: string;
  /** Optional before/after snapshot for rendering an edit diff in the UI. */
  diff?: {
    path: string;
    before: string;
    after: string;
  };
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking: () => void;
  /** `id` is the tool_use id, so a result can be matched to its own call. */
  onToolCall: (id: string, name: string, input: Record<string, unknown>) => void;
  onToolResult: (id: string, name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
  /** History was trimmed before this turn's first call; `turns` user turns were dropped. */
  onTrim?: (turns: number) => void;
}

// ─── Chat Sessions ──────────────────────────────────────────────────────────

/**
 * One rendered entry in a session's transcript. This is the UI-facing
 * history, replayed into the view when a session is opened; the API-facing
 * history lives separately in `AgentLoop`.
 */
export interface ChatHistoryEntry {
  /**
   * "user" | "assistant" | "error" | "tool-call" | "notice". A "tool-call" is
   * recorded when the call starts and gets its `toolResult` when it returns, so
   * a call still in flight replays as running. Older saves stored completed
   * calls as "tool-result" entries instead; those still replay. A "notice" is
   * shown to the user only and never sent to the model.
   */
  type: string;
  text?: string;
  /** The tool_use id, matching a result back to its call. */
  toolId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
}

/**
 * Per-conversation OpenAI Responses API state.
 *
 * The Responses API threads multi-turn context server-side via
 * `previous_response_id`, so this MUST be per session. It used to be a
 * module-level singleton in `api/openai.ts`, which meant a second session
 * would send the first session's response id and OpenAI would splice the
 * wrong conversation in — the exact cross-session bleed sessions exist to
 * prevent, and invisible from the UI.
 */
export interface OpenAIConversationState {
  previousResponseId: string | null;
}

/**
 * Something that happened in a session, sent to the views showing it. The
 * session's own state is updated first regardless of who is listening, which
 * is what lets a run carry on while no view is showing it.
 */
export type SessionEvent =
  | { kind: "message"; entry: ChatHistoryEntry }
  | { kind: "tool-result"; toolId: string; toolName: string; result: ToolResult }
  | { kind: "thinking"; on: boolean }
  | { kind: "ask-user"; question: string }
  | { kind: "running"; running: boolean }
  | { kind: "title"; title: string }
  | { kind: "trimmed" }
  | { kind: "cleared" };

/** A session as persisted to disk. */
export interface SessionSnapshot {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  chatHistory: ChatHistoryEntry[];
  agentMessages: UnifiedMessage[];
  openai: OpenAIConversationState;
}

/** Shape of `chat-state.json` since multi-session support. */
export interface PersistedChatState {
  version: 2;
  activeSessionId: string | null;
  sessions: SessionSnapshot[];
  /**
   * Ids of deleted sessions. The file syncs between devices and each save
   * keeps sessions it doesn't know about, so without these a session deleted
   * on one device would be written back by another that still has it.
   */
  deleted?: string[];
}
