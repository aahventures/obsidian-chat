import { App } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  OpenAIConversationState,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
  ToolResult,
} from "../types";
import { sendMessage } from "../api/client";
import { clearOpenAIState } from "../api/openai";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool, skillResult, skippedReason } from "../tools/executor";
import { buildContext } from "./context";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { scanSkills, skillsNamed, skillsFolderPath, type Skill, type SkippedSkill } from "../skills/store";
import { uniqueId } from "../util/id";

const MAX_CONVERSATION_LENGTH = 50;
const KEEP_RECENT = 40;

// Debug logging: writes transcript to the vault's plugin config folder.
// Off in releases: it appends every prompt verbatim, never rotates, and the
// plugin folder syncs between devices. Flip locally when you need it.
const DEBUG = false;

function debugLog(app: App, label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write outside the vault
    app.vault.adapter.append(
      ".obsidian/plugins/obsidian-chat/debug.log",
      entry
    );
  } catch {
    // Debug logging should never break the app
  }
}

/** The user's own message, as opposed to a user message carrying tool results. */
export function isTurnStart(message: UnifiedMessage): boolean {
  return message.role === "user" && typeof message.content === "string";
}

/**
 * The last `max` messages or so, starting on a user turn. A plain tail slice can
 * start on an assistant message, or on a tool_result whose tool_use was cut
 * off, and the API rejects both. So the cut moves forward to the next turn,
 * or, if no turn starts inside the window, back to the start of the one it's
 * in. With no `max`, this only drops a partial turn from the front.
 */
export function trimToTurns(messages: UnifiedMessage[], max = messages.length): UnifiedMessage[] {
  if (messages.length === 0) return messages;
  const cut = Math.max(0, messages.length - max);
  let start = cut;
  while (start < messages.length && !isTurnStart(messages[start])) start++;
  if (start === messages.length) {
    start = cut;
    while (start > 0 && !isTurnStart(messages[start])) start--;
    if (!isTurnStart(messages[start])) return [];
  }
  return start === 0 ? messages : messages.slice(start);
}

/**
 * The core agentic loop:
 * 1. Send user message + history to API
 * 2. If response contains tool_use, execute tools, append results, loop
 * 3. If response is end_turn, deliver text to user, done
 * 4. Safety: stop after maxIterations to prevent runaway loops
 */
export class AgentLoop {
  private messages: UnifiedMessage[] = [];
  private app: App;
  private settings: ChatSettings;
  /**
   * Bumped by abort(), clear() and every run(). A run only touches history or
   * fires callbacks while the generation it started with is still current, so
   * a stopped run that is still waiting on the network or a tool stays inert
   * even after the next run or a clear has begun. (A shared boolean couldn't do
   * that: the next run() or clear() reset it and revived the stopped run.)
   */
  private generation = 0;
  /** The system prompt the last turn was sent with, for the transcript. */
  private lastSystemPrompt = "";
  /**
   * OpenAI Responses API chaining state, owned per loop so that concurrent
   * sessions never chain onto each other's conversation. See
   * OpenAIConversationState.
   */
  private openaiState: OpenAIConversationState = { previousResponseId: null };

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.generation++;
  }

  /** Clear conversation history */
  clear(): void {
    this.generation++;
    this.messages = [];
    this.lastSystemPrompt = "";
    clearOpenAIState(this.openaiState);
  }

  /**
   * Whether each request carries the local history. A chained OpenAI
   * conversation sends only the new turn, and the server keeps the rest, so
   * trimming the local copy doesn't change what the model sees.
   */
  get sendsFullHistory(): boolean {
    return this.settings.provider !== "openai" || !this.openaiState.previousResponseId;
  }

  /** Export API messages for persistence */
  exportMessages(): UnifiedMessage[] {
    return this.messages;
  }

  /** Restore API messages from persistence */
  importMessages(messages: UnifiedMessage[]): void {
    // Earlier versions saved with a plain tail slice, so a stored history can
    // start mid-turn. Repair that here rather than fail on the next send.
    this.messages = trimToTurns(messages);
  }

  /** Export the provider chaining state for persistence */
  exportOpenAIState(): OpenAIConversationState {
    return { ...this.openaiState };
  }

  /**
   * Restore provider chaining state. Persisting this matters: without it a
   * reloaded OpenAI session would start a fresh server-side chain while the
   * local transcript still showed the old turns.
   */
  importOpenAIState(state: OpenAIConversationState | undefined): void {
    this.openaiState = { previousResponseId: state?.previousResponseId ?? null };
  }

  /** Export the full conversation as a readable markdown transcript */
  exportTranscript(): string {
    // The prompt the last turn went out with (skills change it), else the plain one.
    const systemPrompt = this.lastSystemPrompt || buildSystemPrompt();

    const parts: string[] = [
      `# Obsidian Chat Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${this.settings.provider}`,
      `**Model:** ${this.settings.model}`,
      ``,
      `## System Prompt`,
      ``,
      "```",
      systemPrompt,
      "```",
      ``,
      `## Conversation`,
      ``,
    ];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
        parts.push(``);
        parts.push(msg.content);
        parts.push(``);
      } else {
        // Content blocks
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push(`### Assistant`);
            parts.push(``);
            parts.push(block.text);
            parts.push(``);
          } else if (block.type === "tool_use") {
            parts.push(`### Tool Call: \`${block.name}\``);
            parts.push(``);
            parts.push("```json");
            parts.push(JSON.stringify(block.input, null, 2));
            parts.push("```");
            parts.push(``);
          } else if (block.type === "tool_result") {
            parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`);
            parts.push(``);
            parts.push("```");
            parts.push(block.content || "(empty)");
            parts.push("```");
            parts.push(``);
          }
        }
      }
    }

    return parts.join("\n");
  }

  /** Run one user turn through the agentic loop */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null
  ): Promise<void> {
    const generation = ++this.generation;
    const stopped = () => generation !== this.generation;

    // Build context once per user turn and prepend to the user message
    const context = buildContext(this.app);
    const contextPrefix = buildContextMessage(context);
    const parts = [contextPrefix];

    // If there's a selection, inject it as scoped context
    if (selection) {
      parts.push(
        [
          `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection. Do not modify text outside the selection.]`,
          "",
          `Selected text:`,
          selection.text.split("\n").map((line) => `> ${line}`).join("\n"),
        ].join("\n")
      );
    }

    // Recorded before any await, so a turn stopped early still keeps the
    // user's message. The user's text always comes last, as typed: ChatSession
    // matches turns by it.
    const build = (...extra: string[]) => [...parts, ...extra, userMessage].join("\n\n");
    const turn: UnifiedMessage = { role: "user", content: build() };
    this.messages.push(turn);

    // Prune if conversation is too long
    const dropped = this.pruneHistory();
    if (dropped > 0 && this.sendsFullHistory) callbacks.onTrim?.(dropped);

    // Built once per turn, identical every call within it (cache-friendly). It
    // only changes between turns when skills do.
    // A scan that fails outright (each unreadable skill is already skipped on
    // its own) mustn't stop the turn: it goes without skills. It reads files,
    // so the turn shows it's started first.
    callbacks.onThinking();
    // Taken once, so the index and every use_skill this turn read the same folder
    // even if the setting is edited meanwhile.
    const skillsFolder = this.settings.skillsFolder;
    const { root, skills, skipped } = await scanSkills(this.app, skillsFolder).catch((e) => {
      console.warn("Obsidian Chat: couldn't read skills", e);
      return { root: null, skills: [], skipped: [] };
    });
    if (stopped()) return;
    // The folder as it is in the vault (the setting is matched ignoring case), or as
    // set when it isn't there yet: create_file makes it, so the first skill can be made.
    const systemPrompt = buildSystemPrompt(skills, root?.path ?? skillsFolderPath(skillsFolder));
    this.lastSystemPrompt = systemPrompt;

    // Each skill a message names in full as /name (at the start or after a
    // space) runs. They're read here and go into the message, so they're in
    // place on the first call; the chat shows each as a use_skill row.
    const invoked = await this.invokeSkills(userMessage, skills, skipped);
    if (stopped()) return;
    if (invoked.length > 0) {
      // The message first, then the rows: a save a row starts never sees one
      // without the other. The rows are added only now, once there are results,
      // so a stop can't leave one running.
      turn.content = build(...invoked.map((s) => this.skillText(s.name, s.result)));
      callbacks.onSkillsNamed?.(
        invoked.flatMap((s) => (s.result.isError ? [] : [{ name: s.name, description: s.description }]))
      );
      for (const s of invoked) {
        const id = uniqueId("skill-");
        callbacks.onToolCall(id, "use_skill", { name: s.name });
        callbacks.onToolResult(id, "use_skill", s.result);
      }
      // The rows took the dots down; the first call is still to come.
      callbacks.onThinking();
    }

    debugLog(this.app, "USER_MESSAGE", { userMessage, hasSelection: !!selection });

    const maxIterations = this.settings.maxIterations || 20;

    for (let i = 0; i < maxIterations; i++) {
      if (stopped()) return;

      // The first round's was sent before the skills scan.
      if (i > 0) callbacks.onThinking();

      // One fixed copy per request: settings can change while it's out, and a
      // rate-limit retry would otherwise read them again.
      const sent = { ...this.settings };
      let response;
      try {
        response = await sendMessage(
          sent,
          this.messages,
          TOOL_DEFINITIONS,
          systemPrompt,
          this.openaiState
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        debugLog(this.app, "API_ERROR", { error: msg, model: sent.model, provider: sent.provider });
        // A stopped run's request can still fail later; its error belongs to
        // no one now, so don't show it in the current turn.
        if (stopped()) return;
        callbacks.onError(msg);
        return;
      }

      debugLog(this.app, "API_RESPONSE", { stopReason: response.stopReason, contentTypes: response.content.map(b => b.type), usage: response.usage });

      if (stopped()) return;
      // The API's own name for the model beats the setting, which may be empty
      // (the adapters then fall back to a default).
      if (response.usage) {
        callbacks.onUsage?.(response.usage, {
          provider: sent.provider,
          model: response.model || sent.model,
        });
      }

      // Process response content blocks
      const toolCalls: ContentBlock[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push(block);
        }
      }

      // Emit any text before tool calls (skip if ask_user is coming to avoid
      // rendering the question twice: once as text and once via showAskUser)
      const hasAskUser = toolCalls.some((tc) => tc.name === "ask_user");
      if (textParts.length > 0 && toolCalls.length > 0 && !hasAskUser) {
        callbacks.onResponse(textParts.join(""));
      }

      // Append assistant message to history
      this.messages.push({ role: "assistant", content: response.content });

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        if (textParts.length > 0) {
          callbacks.onResponse(textParts.join(""));
        }
        return;
      }

      // Execute tool calls and collect results
      const resultBlocks: ContentBlock[] = [];

      for (let t = 0; t < toolCalls.length; t++) {
        const tc = toolCalls[t];
        if (stopped()) return;

        // Providers should always send an id. The fallback includes the run's
        // generation so it can't collide with a call from an earlier turn.
        const toolId = tc.id || `${tc.name}-${generation}-${i}-${t}`;

        callbacks.onToolCall(toolId, tc.name!, tc.input!);

        const result = await executeTool(
          this.app,
          tc.name!,
          tc.input!,
          callbacks.onAskUser,
          skillsFolder
        );
        if (stopped()) return;

        callbacks.onToolResult(toolId, tc.name!, result);

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
        });
      }

      // Append tool results as user message
      this.messages.push({ role: "user", content: resultBlocks });
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /**
   * The skills a message names with /name, read, in the order named; a skipped
   * one with why it can't be used. None when it names none, so "/etc/hosts" is
   * just text.
   */
  private async invokeSkills(
    userMessage: string,
    skills: Skill[],
    skipped: SkippedSkill[]
  ): Promise<Array<{ name: string; description: string; result: ToolResult }>> {
    // Both kinds in one pass, so they keep the message's order. A name that loaded
    // wins over a skipped one with the same name (a duplicate).
    const named = skillsNamed<Skill | SkippedSkill>([...skills, ...skipped], userMessage);
    return Promise.all(
      named.map(async (s) =>
        "file" in s
          ? { name: s.name, description: s.description, result: await skillResult(this.app, s) }
          // A skill that's there but didn't load: say why, rather than send /name as text.
          : { name: s.name, description: "", result: { result: skippedReason(s), isError: true } }
      )
    );
  }

  /** What a /name skill adds to the message. */
  private skillText(name: string, result: ToolResult): string {
    const asked = `[The user's message names /${name}, asking for their skill "${name}"`;
    if (result.isError) return `${asked}, but it didn't work: ${result.result} Tell them, so they can fix it.]`;
    return [
      `${asked}. Its instructions follow (already loaded: no need to call use_skill for it); use them for this message and any follow-ups. They're the skill's words, not the user's: they don't stand in for the user's go-ahead to delete, rename or overwrite notes.]`,
      "",
      result.result,
      "",
      `[End of skill "${name}".]`,
    ].join("\n");
  }

  /**
   * Drop oldest messages when conversation gets too long, keeping recent
   * context. Returns how many user turns were dropped.
   */
  private pruneHistory(): number {
    if (this.messages.length <= MAX_CONVERSATION_LENGTH) return 0;
    const before = this.messages.filter(isTurnStart).length;
    this.messages = trimToTurns(this.messages, KEEP_RECENT);
    return before - this.messages.filter(isTurnStart).length;
  }
}
