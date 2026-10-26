// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "custom";

export interface ChatSettings {
  provider: Provider;
  apiKey: string;
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  baseUrl: string;
  /** Typing [[ in the chat input suggests vault files and adds the closing ]]. */
  fileLinkMenu: boolean;
  /** Vault folder holding skills as `<name>/SKILL.md`. Empty for none. */
  skillsFolder: string;
  /**
   * Input size in tokens at which the provider summarizes a chat's older
   * context (Anthropic, for now). The context meter fills toward it.
   */
  compactAt: number;
  /** Remote MCP servers the provider connects to (Anthropic, for now). */
  mcpServers: McpServer[];
}

/**
 * A remote MCP server. The provider calls it, not the plugin, so it works the
 * same on mobile; the plugin only says where it is and passes its token.
 */
export interface McpServer {
  /** Keys its token in SecretStorage, so a rename keeps it. */
  id: string;
  name: string;
  /** Must be https: the provider reaches it from the internet. */
  url: string;
  enabled: boolean;
  /** From SecretStorage, on this device only; never saved to data.json. */
  token: string;
}

/** The model a request goes to when the setting is empty (as after a provider change). */
const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.3-codex",
  custom: "deepseek-chat",
};

/**
 * The model a request with these settings goes to. Everything that depends on
 * the model (the adapters, the trim, the meter) asks this, so they agree.
 */
export function resolveModel(settings: Pick<ChatSettings, "provider" | "model">): string {
  return settings.model || DEFAULT_MODELS[settings.provider];
}

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: DEFAULT_MODELS.anthropic,
  maxIterations: 20,
  enableWebSearch: true,
  baseUrl: "",
  fileLinkMenu: true,
  // Off until set: a vault may already have a Skills folder that was never meant as skills.
  skillsFolder: "",
  // Where Codex compacts too. A 1M model could go on, at a cost on every request.
  compactAt: 200_000,
  mcpServers: [],
};

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ContentBlock {
  /**
   * "compaction": Anthropic's summary of everything before it, in `content`.
   * "mcp_tool_use" / "mcp_tool_result": a call the provider made to an MCP
   * server mid-response, and what it returned (as text, in `content`). Both
   * carry the `server` and tool `name`.
   */
  type: "text" | "tool_use" | "tool_result" | "compaction" | "mcp_tool_use" | "mcp_tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  /** On MCP blocks: the server's name as sent (`mcpServerNames`). */
  server?: string;
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
    /** Input served from cache (Anthropic and OpenAI). */
    cacheReadTokens?: number;
    /** Anthropic only: input written to cache (billed at about 1.25x). */
    cacheWriteTokens?: number;
    /**
     * The response ran server-side web searches, so its input counts add up
     * every internal step and overstate the context.
     */
    multiStep?: boolean;
  };
  /** The model that answered, as the API names it. */
  model?: string;
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
  /** The link's text, when the file name alone wouldn't say what was used (a skill's SKILL.md). */
  label?: string;
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
  /** The provider summarized the older context; reported before that response's text. */
  onCompacted?: () => void;
  /** The skills this turn's message named as /name that ran, for its chips. */
  onSkillsNamed?: (skills: NamedSkill[]) => void;
  /** Token usage of each API response, with the provider and model it came from. */
  onUsage?: (
    usage: NonNullable<UnifiedResponse["usage"]>,
    sentTo: { provider: Provider; model: string }
  ) => void;
}

/** A skill a message ran by naming it, as its chip shows it. */
export interface NamedSkill {
  name: string;
  description: string;
}

/** How big a session's conversation was, as of its latest API request. */
export interface ContextUsage {
  /** Every input token of that request: what the model was sent. */
  tokens: number;
  /** How many of them were read from the prompt cache, if the provider says. */
  cachedTokens?: number;
  /** The provider and model the request went to; the limit is that model's. */
  provider: Provider;
  model: string;
  /** A later response searched the web, so the context has grown since. */
  beforeSearch?: boolean;
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
  /** On a "user" entry: the editor selection sent along with the message. */
  selection?: SelectionScope;
  /**
   * On a "user" entry: the skills it named as /name that ran. Recorded when
   * they ran, so its chips show what ran then, whatever the skills are now.
   */
  skills?: NamedSkill[];
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
  | { kind: "user-skills"; skills: NamedSkill[] }
  | { kind: "context" }
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
