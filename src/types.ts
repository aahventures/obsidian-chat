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
    inputTokens: number;
    outputTokens: number;
  };
}

// ─── Provider State ─────────────────────────────────────────────────────────

/**
 * Per-conversation state held on the provider's side.
 *
 * OpenAI's Responses API keeps conversation state server-side and is chained
 * via `previous_response_id`, so this must be scoped to a single conversation.
 * Sharing one instance across conversations splices them together server-side.
 * Anthropic and custom (OpenAI-compatible) providers are stateless and ignore it.
 */
export interface ProviderState {
  previousResponseId: string | null;
}

/** A fresh, unchained provider state. */
export function createProviderState(): ProviderState {
  return { previousResponseId: null };
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
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
}
