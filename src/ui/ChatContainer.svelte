<script lang="ts">
  import { tick } from "svelte";
  import type { App, Component as ObsidianComponent, TFile } from "obsidian";
  import { Keymap, MarkdownRenderer, Notice, prepareFuzzySearch } from "obsidian";
  import type { ToolResult, SelectionScope } from "../types";
  import { lineDiff } from "../util/diff";

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "notice" | "divider" | "thinking";
    text?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
    /** On a user message: the editor selection that was sent with it. */
    selection?: SelectionScope;
  }

  interface Props {
    app: App;
    component: ObsidianComponent;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null) => void;
    onClear: () => void;
    onStop: () => void;
    onNewSession: () => void;
    onSelectSession: (id: string) => void;
    /** Asked for just before the dropdown opens, so its list is current. */
    onRefreshSessions: () => void;
    /** Whether typing [[ suggests files; read live so the setting applies at once. */
    fileLinkMenuEnabled: () => boolean;
  }

  let {
    app,
    component,
    provider,
    model,
    onSend,
    onClear,
    onStop,
    onNewSession,
    onSelectSession,
    onRefreshSessions,
    fileLinkMenuEnabled,
  }: Props = $props();

  let displayModel = $state("");
  // The pane's session title. Sidebar tab bars show icons only, so this is
  // what tells one chat pane from another.
  let displayTitle = $state("Chat");
  // Session switcher state, pushed in from chat-view.ts via setSessions().
  let sessions = $state<Array<{ id: string; title: string }>>([]);
  let activeSessionId = $state("");
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let placeholder = $state("Ask anything...");
  /** The input is answering an ask_user question, which can't carry a selection. */
  let awaitingAnswer = $state(false);
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let nextId = 0;

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // Sync model prop to local state (also updateable via setModel)
  $effect(() => {
    displayModel = model;
  });

  // Auto-scroll when messages change
  $effect(() => {
    // Track messages array length to trigger scroll
    messages.length;
    if (messagesEl) {
      requestAnimationFrame(() => {
        messagesEl!.scrollTop = messagesEl!.scrollHeight;
      });
    }
  });

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(text: string, selection?: SelectionScope): void {
    messages.push({ id: nextId++, type: "user", text, selection });
  }

  export function addAssistantMessage(text: string): void {
    messages.push({ id: nextId++, type: "assistant", text });
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
    }
  }

  export function showThinking(): void {
    // Only add if not already showing
    if (!messages.some((m) => m.type === "thinking")) {
      messages.push({ id: nextId++, type: "thinking" });
    }
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string): void {
    messages.push({ id: nextId++, type: "error", text });
  }

  /** A note for the user only; the model never sees it. */
  export function addNotice(text: string): void {
    messages.push({ id: nextId++, type: "notice", text });
  }

  /** Marks where the model's view of the conversation starts. */
  export function addDivider(): void {
    messages.push({ id: nextId++, type: "divider" });
  }

  /**
   * Invite an answer to a pending ask_user question. The question is rendered
   * as an ordinary assistant message by the session, and the answer goes back
   * through `onSend` like any other input, so the component holds no resolver
   * and a question can outlive the component being unmounted.
   */
  export function promptAnswer(): void {
    placeholder = "Type your answer...";
    inputEnabled = true;
    awaitingAnswer = true;
    textareaEl?.focus();
  }

  export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
    awaitingAnswer = false;
    placeholder = enabled ? "Ask anything..." : "Reply in progress...";
  }

  export function clearMessages(): void {
    messages = [];
    selection = null;
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /**
   * Drop whatever is half-typed. A draft belongs to the session it was typed
   * in, so it mustn't follow the view to another one.
   */
  export function clearInput(): void {
    inputText = "";
    // An open [[ menu is part of the draft too.
    mention = null;
    dismissedStart = -1;
    resetHeight();
  }

  /** Update the model display name in the header */
  /** Replace the session list shown in the switcher. */
  export function setSessions(
    list: Array<{ id: string; title: string }>,
    activeId: string
  ): void {
    sessions = list;
    activeSessionId = activeId;
  }

  function handleSessionChange(event: Event): void {
    const id = (event.currentTarget as HTMLSelectElement).value;
    if (id && id !== activeSessionId) onSelectSession(id);
  }

  export function setModel(name: string): void {
    displayModel = name;
  }

  export function setTitle(name: string): void {
    displayTitle = name || "Chat";
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  function handleSend(): void {
    // The textarea stays enabled during a turn (disabling it would blur it and
    // drop the mobile keyboard), so sending is blocked here instead.
    if (!inputEnabled) return;
    const text = inputText.trim();
    if (!text) return;

    inputText = "";
    mention = null;
    dismissedStart = -1;
    resetHeight();

    // An answer is a tool result, not a turn, so it can't carry the selection:
    // leave the pill up for the next message instead of consuming it.
    if (awaitingAnswer) {
      onSend(text, null);
      return;
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(text, currentSelection);
  }

  // ─── [[ file links ────────────────────────────────────────────────────
  // Typing [[ adds the closing ]] and opens a menu of vault files, filtered by
  // what's between the brackets (spaces included). Picking one completes the
  // link in the text, so it reads in the sentence and the model sees the note.

  const MENTION_LIMIT = 8;

  /** The [[query being typed at the caret, or null. `start` is the index of the [[. */
  let mention = $state<{ start: number; query: string } | null>(null);
  let mentionIndex = $state(0);
  /** A [[ escaped out of: stays plain text until the caret leaves it. */
  let dismissedStart = -1;
  let menuEl: HTMLElement | undefined = $state();

  const mentionResults = $derived(mention ? searchFiles(mention.query) : []);
  const menuOpen = $derived(mentionResults.length > 0);

  /**
   * Keep the highlighted row visible. Only the arrow keys call this: scrolling
   * on hover would move the list under the pointer and fire more hovers.
   */
  function scrollSelectedIntoView(): void {
    void tick().then(() => {
      menuEl?.querySelector(".ochat-mention-selected")?.scrollIntoView({ block: "nearest" });
    });
  }

  function searchFiles(query: string): TFile[] {
    const files = app.vault.getFiles();
    // No query yet: what you touched last is the likeliest target.
    if (!query) {
      return [...files].sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, MENTION_LIMIT);
    }
    // Same matcher as the Quick Switcher, run over the full path so
    // "src/agent/" narrows by folder too and spaces match separate words.
    const match = prepareFuzzySearch(query);
    const scored: { file: TFile; score: number }[] = [];
    for (const file of files) {
      const result = match(file.path);
      if (result) scored.push({ file, score: result.score });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, MENTION_LIMIT)
      .map((s) => s.file);
  }

  /**
   * Look for an unclosed [[ before the caret and open, update or close the menu.
   * Only typing opens it. Moving the caret (arrows, a click) can close or refine
   * a menu that's already open, but never opens one or hops it to another link,
   * as in Obsidian: otherwise Enter inside a finished link would pick a file.
   */
  function updateMention(typing: boolean): void {
    if (!textareaEl || !fileLinkMenuEnabled()) {
      mention = null;
      return;
    }
    const before = textareaEl.value.slice(0, textareaEl.selectionStart);
    const m = /\[\[([^[\]\n]*)$/.exec(before);
    if (!m) {
      mention = null;
      dismissedStart = -1;
      return;
    }
    const start = m.index;
    if (!typing && mention?.start !== start) {
      mention = null;
      return;
    }
    if (start === dismissedStart) {
      mention = null;
      return;
    }
    if (mention?.start === start && mention.query === m[1]) return;
    mentionIndex = 0;
    if (menuEl) menuEl.scrollTop = 0;
    mention = { start, query: m[1] };
  }

  /** Complete the link: [[query]] becomes [[Note name]], caret after it. */
  function confirmMention(file: TFile | undefined): void {
    // The list can shrink under the highlighted row (a file deleted mid-typing).
    if (!file || !mention || !textareaEl) return;
    const { start, query } = mention;
    const head = inputText.slice(0, start);
    // Replace the whole [[...]] when it's closed, even with the caret mid-query
    // (the query is only the text before the caret). The closing ]] was added
    // when [[ was typed, so this also keeps it from doubling.
    const closed = /^[^[\]\n]*\]\]/.exec(inputText.slice(start + 2));
    const linkEnd = closed ? start + 2 + closed[0].length : start + 2 + query.length;
    const tail = inputText.slice(linkEnd);
    // Obsidian's own link text: just the name, with the folder only when two
    // files share it. The tools that read, edit or open a note resolve it.
    const link = `[[${app.metadataCache.fileToLinktext(file, "")}]]`;
    inputText = head + link + tail;
    mention = null;
    const end = head.length + link.length;
    void tick().then(() => {
      textareaEl?.focus();
      textareaEl?.setSelectionRange(end, end);
      autoGrow();
    });
  }

  function handleKeydown(e: KeyboardEvent): void {
    // Enter confirms an IME candidate (CJK input); it must not send. keyCode
    // 229 covers browsers that fire keydown after compositionend.
    if (e.isComposing || e.keyCode === 229) return;

    // Backspacing the [[ typed just before its auto-added ]] removes all four
    // brackets, so the ]] isn't left behind. Brackets typed by hand ([], [ ])
    // get a normal Backspace.
    if (
      e.key === "Backspace" &&
      fileLinkMenuEnabled() &&
      textareaEl &&
      textareaEl.selectionStart === textareaEl.selectionEnd
    ) {
      const caret = textareaEl.selectionStart;
      const value = textareaEl.value;
      if (value.slice(caret - 2, caret + 2) === "[[]]") {
        e.preventDefault();
        inputText = value.slice(0, caret - 2) + value.slice(caret + 2);
        void tick().then(() => {
          textareaEl?.setSelectionRange(caret - 2, caret - 2);
          updateMention(false);
        });
        return;
      }
    }

    if (menuOpen && fileLinkMenuEnabled()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = mentionResults.length;
        mentionIndex = (mentionIndex + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        scrollSelectedIntoView();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        confirmMention(mentionResults[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissedStart = mention?.start ?? -1;
        mention = null;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInput(e: Event): void {
    // Off: [[ is plain text, and the vault is never scanned.
    if (!fileLinkMenuEnabled()) {
      mention = null;
      autoGrow();
      return;
    }
    const ie = e as InputEvent;
    // Typing the second [ adds the closing ]], as Obsidian's editor does. Keyed
    // on the typed character, not the input type: some mobile keyboards report
    // punctuation as composition input.
    if (textareaEl && ie.data === "[") {
      const caret = textareaEl.selectionStart;
      const value = textareaEl.value;
      if (value.slice(caret - 2, caret) === "[[" && !value.slice(caret).startsWith("]]")) {
        inputText = value.slice(0, caret) + "]]" + value.slice(caret);
        // Setting the value moves the caret to the end; put it between the brackets.
        void tick().then(() => textareaEl?.setSelectionRange(caret, caret));
      }
    }
    autoGrow();
    updateMention(true);
  }

  /**
   * Tapping send/stop shouldn't pull focus (and the mobile keyboard) off the
   * textarea. Focus moves as the default action of mousedown (touch taps fire
   * a compat one), so that is what has to be cancelled, not pointerdown.
   */
  function keepFocus(e: MouseEvent): void {
    e.preventDefault();
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 300) + "px";
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
  }

  // Render markdown into a DOM node using Obsidian's renderer
  function renderMarkdown(node: HTMLElement, text: string): void {
    node.empty();
    MarkdownRenderer.render(app, text, node, "", component);
  }

  // Use action for markdown rendering
  function markdown(node: HTMLElement, text: string) {
    renderMarkdown(node, text);
    // Obsidian only resolves internal links for panes that are backed by a
    // file; a chat pane is not one, so rendered [[wikilinks]] and relative
    // markdown links sit there inert unless we navigate them ourselves.
    node.addEventListener("click", handleLinkClick);
    node.addEventListener("auxclick", handleLinkClick);
    return {
      update(newText: string) {
        renderMarkdown(node, newText);
      },
      destroy() {
        node.removeEventListener("click", handleLinkClick);
        node.removeEventListener("auxclick", handleLinkClick);
      },
    };
  }

  /**
   * Which pane a click asks for: mod-click a new tab or split, middle-click a
   * new tab, plain click the last-used main-area pane. Same rules as
   * Obsidian's own links, so the chat does not feel like an exception.
   */
  function panePreference(event: MouseEvent): ReturnType<typeof Keymap.isModEvent> {
    return event.button === 1 ? "tab" : Keymap.isModEvent(event);
  }

  /** Percent-encoded paths come through markdown-style links: `[x](A%20B.md)`. */
  function decodeLinkText(href: string): string {
    try {
      return decodeURIComponent(href);
    } catch {
      return href;
    }
  }

  /**
   * Open an internal link clicked inside a rendered message.
   *
   * External links are left alone — the browser and Obsidian already handle
   * those. Links are resolved against the note you are currently looking at,
   * which is what makes a bare `[[Note]]` behave the way it would in that
   * note, and are checked before opening so a link to something that is not
   * in the vault says so instead of creating an empty note.
   */
  function handleLinkClick(event: MouseEvent): void {
    // auxclick covers every non-primary button; only middle-click navigates.
    if (event.type === "auxclick" && event.button !== 1) return;

    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;

    // data-href is what Obsidian puts the link target in; requiring it (or the
    // internal-link class) keeps footnote and tag anchors out of here.
    const raw = anchor.getAttribute("data-href");
    const href = raw ?? (anchor.classList.contains("internal-link") ? anchor.getAttribute("href") : null);
    if (!href) return;

    // Stop here rather than let the click bubble on to anything else.
    event.preventDefault();
    event.stopPropagation();

    const sourcePath = app.workspace.getActiveFile()?.path ?? "";
    // A subpath-only link (`[[#Heading]]`) targets the current note itself.
    const resolves = (text: string) => {
      const target = text.split("#")[0];
      return !target || app.metadataCache.getFirstLinkpathDest(target, sourcePath) !== null;
    };
    // Markdown links can arrive percent-encoded and wikilinks never do, but
    // the anchor does not say which this was. Try the text as written first,
    // so a note with a literal `%20` in its name still opens.
    const linktext = [href, decodeLinkText(href)].find(resolves);
    if (linktext === undefined) {
      new Notice(`No note matching "${decodeLinkText(href).split("#")[0]}" in the vault.`);
      return;
    }

    void app.workspace.openLinkText(linktext, sourcePath, panePreference(event));
  }

  function formatToolName(name: string): string {
    return name.replace(/_/g, " ");
  }

  /**
   * Short, readable label for a vault path: the file name, without the `.md`
   * that every note carries. The full path stays in the link's tooltip.
   */
  function fileLabel(path: string): string {
    const name = path.split("/").pop() ?? path;
    return name.endsWith(".md") ? name.slice(0, -3) : name;
  }

  /**
   * Open the note a tool touched, so a result can be navigated back to.
   *
   * `getLeaf()` with the event's modifiers matches Obsidian's own links —
   * plain click reuses the last main-area pane, mod-click opens a tab/split.
   */
  function openPath(path: string, event: MouseEvent): void {
    event.preventDefault();
    const file = app.vault.getFileByPath(path);
    if (!file) {
      new Notice(`${path} is no longer in the vault.`);
      return;
    }
    void app.workspace.getLeaf(panePreference(event)).openFile(file);
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }

  // Cap the rendered diff for very large edits: bounds the DOM and the O(n*m)
  // line diff, mirroring the 2000-char truncate on the plain result fallback.
  // Keyed on before/after, so it applies to any future edit type too.
  const MAX_DIFF_CHARS = 6000;
  function diffTooLarge(d: { before: string; after: string }): boolean {
    return d.before.length + d.after.length > MAX_DIFF_CHARS;
  }
</script>

<div class="ochat-container">
  <!-- Header -->
  <div class="ochat-header">
    <div class="ochat-header-left">
      {#if sessions.length > 1}
        <select
          class="ochat-session-select"
          aria-label="Active chat"
          value={activeSessionId}
          onchange={handleSessionChange}
          onpointerdown={onRefreshSessions}
          onfocus={onRefreshSessions}
        >
          {#each sessions as s (s.id)}
            <option value={s.id}>{s.title}</option>
          {/each}
        </select>
      {:else}
        <span class="ochat-header-title" title={displayTitle}>{displayTitle}</span>
      {/if}
      <span class="ochat-header-model">{displayModel || "No model"}</span>
    </div>
    <div class="ochat-header-actions">
      <button class="ochat-clear-btn" onclick={onNewSession} aria-label="New chat">New</button>
      <button class="ochat-clear-btn" onclick={onClear}>Clear</button>
    </div>
  </div>

  <!-- Messages -->
  <div class="ochat-messages" bind:this={messagesEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        {#if msg.selection}
          <!-- The selection sent with this message: a chip above it, tap to read -->
          <details class="ochat-msg-selection">
            <summary>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M13 8H7"></path><path d="M17 12H7"></path></svg>
              <span class="ochat-msg-selection-label">Selection from {msg.selection.filePath.split("/").pop() || "note"}</span>
            </summary>
            <div class="ochat-msg-selection-full">{msg.selection.text}</div>
          </details>
        {/if}
        <div class="ochat-msg ochat-user-msg">
          {#if msg.text?.includes("[[")}
            <!-- Rendered so [[file links]] are clickable; other messages stay plain text -->
            <div class="ochat-msg-content" use:markdown={msg.text}></div>
          {:else}
            <div class="ochat-msg-content">{msg.text}</div>
          {/if}
        </div>

      {:else if msg.type === "assistant"}
        <div class="ochat-msg ochat-assistant-msg">
          <div class="ochat-msg-content" use:markdown={msg.text ?? ""}></div>
        </div>

      {:else if msg.type === "tool-call"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class="ochat-spinner"></span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
          </div>
          <details class="ochat-tool-details">
            <summary>Parameters</summary>
            <pre class="ochat-tool-json">{JSON.stringify(msg.toolInput, null, 2)}</pre>
          </details>
        </div>

      {:else if msg.type === "tool-result"}
        <div class="ochat-tool-call">
          <div class="ochat-tool-status">
            <span class={msg.toolResult?.isError ? "ochat-tool-error" : "ochat-tool-success"}>
              {msg.toolResult?.isError ? "\u2718" : "\u2714"}
            </span>
            <span class="ochat-tool-name">{formatToolName(msg.toolName ?? "")}</span>
            {#if msg.toolResult?.path}
              {@const path = msg.toolResult.path}
              <a
                class="ochat-file-link"
                href={path}
                title={path}
                onclick={(e) => openPath(path, e)}
                onauxclick={(e) => e.button === 1 && openPath(path, e)}
              >{fileLabel(path)}</a>
            {/if}
          </div>
          <details class="ochat-tool-details">
            <summary>{msg.toolResult?.isError ? "Error" : "Result"}</summary>
            {#if msg.toolResult?.diff && !diffTooLarge(msg.toolResult.diff)}
              {@const diffPath = msg.toolResult.diff.path}
              {#if msg.toolResult.result}
                <div class="ochat-diff-summary">{msg.toolResult.result}</div>
              {/if}
              <div class="ochat-diff">
                <a
                  class="ochat-diff-path ochat-file-link"
                  href={diffPath}
                  title={diffPath}
                  onclick={(e) => openPath(diffPath, e)}
                  onauxclick={(e) => e.button === 1 && openPath(diffPath, e)}
                >{diffPath}</a>
                {#each lineDiff(msg.toolResult.diff.before, msg.toolResult.diff.after) as row}
                  <div class="ochat-diff-row ochat-diff-{row.type}">
                    <span class="ochat-diff-gutter">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span><span class="ochat-diff-text">{row.text}</span>
                  </div>
                {/each}
              </div>
            {:else}
              <pre class="ochat-tool-json">{truncate(msg.toolResult?.result ?? "", 2000)}</pre>
            {/if}
          </details>
        </div>

      {:else if msg.type === "error"}
        <div class="ochat-msg ochat-error-msg">
          <div class="ochat-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "notice"}
        <div class="ochat-notice">{msg.text}</div>

      {:else if msg.type === "divider"}
        <div class="ochat-divider" title="Older messages are trimmed from what is sent to keep requests small.">
          <span>⚠ The model can't see anything above this line</span>
        </div>

      {:else if msg.type === "thinking"}
        <div class="ochat-thinking">
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
          <span class="ochat-dot"></span>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Selection pill -->
  {#if selection}
    <div class="ochat-selection-pill" class:ochat-selection-held={awaitingAnswer}>
      <div class="ochat-selection-content">
        <span class="ochat-selection-label">
          {#if awaitingAnswer}
            <svg class="ochat-selection-warn" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
            <span>Not sent with your answer · kept for your next message</span>
          {:else}
            Selection from {selection.filePath.split("/").pop()}
          {/if}
        </span>
        <span class="ochat-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="ochat-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  <!-- [[ file menu -->
  {#if menuOpen}
    <div class="ochat-mention-menu" bind:this={menuEl}>
      {#each mentionResults as file, i (file.path)}
        <button
          class="ochat-mention-item"
          class:ochat-mention-selected={i === mentionIndex}
          onmousedown={keepFocus}
          onmousemove={() => (mentionIndex = i)}
          onclick={() => confirmMention(file)}
        >
          <span class="ochat-mention-name">{file.name}</span>
          <span class="ochat-mention-path">{file.parent?.path === "/" ? "" : file.parent?.path}</span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Input bar -->
  <div class="ochat-input-bar">
    <textarea
      class="ochat-input"
      bind:this={textareaEl}
      bind:value={inputText}
      {placeholder}
      rows="1"
      onkeydown={handleKeydown}
      oninput={handleInput}
      onkeyup={() => updateMention(false)}
      onclick={() => updateMention(false)}
      onblur={() => (mention = null)}
    ></textarea>
    {#if inputEnabled}
      <button
        class="ochat-send-btn"
        onmousedown={keepFocus}
        onclick={handleSend}
        aria-label="Send message"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
      </button>
    {:else}
      <button
        class="ochat-send-btn ochat-stop-btn"
        onmousedown={keepFocus}
        onclick={onStop}
        aria-label="Stop generation"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
      </button>
    {/if}
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .ochat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .ochat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  .ochat-header-left {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .ochat-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
    /* Titles come from the first message, so they can be long. Ellipsize
       rather than push the buttons off the edge. */
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochat-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochat-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }

  /*
   * A native select keeps the switcher usable on mobile (where Obsidian
   * renders the chat as a slide-in panel) without building a custom menu.
   */
  .ochat-session-select {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
    background: none;
    border: none;
    padding: 0;
    max-width: 15ch;
    cursor: pointer;
  }

  .ochat-clear-btn {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-s);
  }

  .ochat-clear-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .ochat-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochat-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochat-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  .ochat-msg-selection {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    max-width: 90%;
    margin-bottom: -4px;
    font-size: var(--font-ui-smaller);
  }

  .ochat-msg-selection summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 10px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-l);
    color: var(--text-muted);
    cursor: pointer;
    list-style: none;
  }

  .ochat-msg-selection summary::-webkit-details-marker {
    display: none;
  }

  .ochat-msg-selection summary:hover,
  .ochat-msg-selection[open] summary {
    color: var(--text-normal);
    border-color: var(--interactive-accent);
  }

  .ochat-msg-selection summary svg {
    flex-shrink: 0;
  }

  .ochat-msg-selection-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochat-msg-selection-full {
    margin-top: 4px;
    padding: 6px 10px;
    max-height: 240px;
    overflow-y: auto;
    border-left: 2px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
    color: var(--text-muted);
    white-space: pre-wrap;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochat-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .ochat-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochat-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .ochat-notice {
    align-self: center;
    color: var(--text-warning);
    font-size: var(--font-ui-smaller);
    text-align: center;
    max-width: 90%;
  }

  .ochat-divider {
    display: flex;
    align-items: center;
    gap: var(--size-4-2);
    color: var(--text-warning);
    font-size: var(--font-ui-smaller);
    font-weight: var(--font-semibold);
    white-space: nowrap;
  }

  .ochat-divider::before,
  .ochat-divider::after {
    content: "";
    flex: 1;
    border-top: 2px solid var(--text-warning);
  }

  .ochat-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  .ochat-tool-call {
    align-self: flex-start;
    padding: 6px 10px;
    background: var(--background-secondary-alt);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    max-width: 90%;
  }

  .ochat-tool-status {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ochat-tool-name {
    font-weight: 500;
    flex-shrink: 0;
  }

  /* The path a tool acted on: click to open the note. Ellipsized rather than
     wrapped, so a deep path never pushes the row wider than the pane. */
  .ochat-file-link {
    color: var(--link-color);
    text-decoration: none;
    cursor: pointer;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochat-file-link:hover {
    color: var(--link-color-hover, var(--link-color));
    text-decoration: underline;
  }

  .ochat-tool-success {
    color: var(--text-success);
  }

  .ochat-tool-error {
    color: var(--text-error);
  }

  .ochat-tool-details {
    margin-top: 4px;
  }

  .ochat-tool-details summary {
    cursor: pointer;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .ochat-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Edit Diff ─────────────────────────────────────────────────────── */
  .ochat-diff-summary {
    margin-top: 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    white-space: pre-wrap;
  }

  .ochat-diff {
    margin-top: 6px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    overflow: hidden;
    font-family: var(--font-monospace);
    font-size: 11px;
    line-height: 1.5;
  }

  .ochat-diff-path {
    display: block;
    padding: 3px 8px;
    background: var(--background-secondary);
    border-bottom: 1px solid var(--background-modifier-border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochat-diff-row {
    display: flex;
    white-space: pre-wrap;
    word-break: break-word;
    /* Text stays high-contrast; only the background is tinted. */
    color: var(--text-normal);
  }

  .ochat-diff-gutter {
    flex: 0 0 1.4em;
    text-align: center;
    user-select: none;
    font-weight: 600;
  }

  .ochat-diff-text {
    flex: 1 1 auto;
  }

  /* Subtle background tint + colored gutter sign, à la Claude Code / GitHub.
     Low-opacity tints read correctly in both light and dark themes. */
  .ochat-diff-add {
    background: rgba(46, 160, 67, 0.18);
  }
  .ochat-diff-add .ochat-diff-gutter {
    color: var(--color-green);
  }

  .ochat-diff-del {
    background: rgba(248, 81, 73, 0.18);
  }
  .ochat-diff-del .ochat-diff-gutter {
    color: var(--color-red);
  }

  .ochat-diff-ctx {
    color: var(--text-muted);
  }
  .ochat-diff-ctx .ochat-diff-gutter {
    color: var(--text-faint);
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .ochat-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: ochat-spin 0.6s linear infinite;
  }

  @keyframes ochat-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .ochat-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .ochat-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: ochat-pulse 1.4s ease-in-out infinite;
  }

  .ochat-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ochat-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes ochat-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .ochat-input-bar {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--background-modifier-border);
    background: transparent;
    flex-shrink: 0;
  }

  .ochat-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: 20px;
    padding: 8px 16px;
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    max-height: 300px;
    overflow-y: auto;
    box-shadow: none;
  }

  .ochat-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .ochat-send-btn {
    width: 34px;
    height: 34px;
    min-width: 34px;
    min-height: 34px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .ochat-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .ochat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ochat-stop-btn {
    background-color: var(--text-error);
  }

  .ochat-stop-btn:hover {
    background-color: var(--text-error);
    opacity: 0.85;
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .ochat-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .ochat-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* An answer can't carry the selection, so show it waiting rather than attached. */
  .ochat-selection-held {
    border-color: var(--text-warning);
  }

  .ochat-selection-held .ochat-selection-label {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    color: var(--text-warning);
  }

  .ochat-selection-warn {
    flex-shrink: 0;
    margin-top: 2px;
  }

  .ochat-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .ochat-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochat-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ochat-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* A rendered user message wraps its text in <p>; trim the ends like the assistant's. */
  .ochat-user-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochat-user-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  /* Links in your own bubble. The theme colours links through these variables, so
     set them rather than fight the rule: the theme's link colour is lost on the
     accent background. Hover dims the text colour so it still changes. */
  .ochat-user-msg {
    --link-color: var(--text-on-accent);
    --link-color-hover: color-mix(in srgb, var(--text-on-accent) 70%, transparent);
  }

  .ochat-user-msg :global(a) {
    text-decoration: underline;
  }

  /* ─── [[ file menu ────────────────────────────────────────────────────── */
  .ochat-mention-menu {
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow-y: auto;
    margin: 8px 8px 0;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .ochat-mention-item {
    display: flex;
    align-items: baseline;
    justify-content: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    text-align: left;
    height: auto;
    cursor: pointer;
  }

  .ochat-mention-selected {
    background: var(--background-modifier-hover);
  }

  .ochat-mention-name {
    flex-shrink: 0;
    color: var(--text-normal);
  }

  .ochat-mention-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .ochat-msg {
      max-width: 95%;
    }

    /* Obsidian's mobile drawer already reserves the bottom safe area (and room
       for its navbar), so adding env(safe-area-inset-bottom) here double-counts
       it and leaves a gap under the input. */
    .ochat-input-bar {
      gap: 10px;
      padding: 10px 12px;
    }

    .ochat-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
      padding: 10px 16px;
      border-radius: 22px;
    }

    .ochat-send-btn {
      width: 36px;
      height: 36px;
      min-width: 36px;
      min-height: 36px;
    }
  }
</style>
