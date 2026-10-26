# Obsidian Chat

Agentic AI chat plugin for Obsidian. Simple, mobile-first, two providers (Anthropic + OpenAI).

## Architecture

```
User Input -> Agent Loop -> API Client (requestUrl) -> Claude/OpenAI
                 |                                         |
            Tool Executor  <---  tool_use response  <------+
                 |
         Obsidian Vault APIs (read/edit/search/create)
```

- **API clients** use `requestUrl()` (not `fetch`) because mobile WebViews enforce CORS
- **Anthropic** uses Messages API with adaptive thinking and prompt caching
- **OpenAI** uses Responses API with `previous_response_id` for multi-turn
- **Agent loop** is provider-agnostic: send -> tools -> send -> done
- **UI** is a single Svelte 5 component (`ChatContainer.svelte`) mounted in an `ItemView`

## Project Structure

```
src/
  main.ts                # Plugin entry: commands, panes, settings, context menus, persistence
  sessions.ts            # SessionStore: every conversation, runs their turns, merge-on-save
  types.ts               # All interfaces and defaults
  settings.ts            # PluginSettingTab with model fetching
  api/
    client.ts            # Dispatcher: routes to anthropic or openai adapter
    anthropic.ts         # Messages API, adaptive thinking, cache_control
    openai.ts            # Responses API, previous_response_id chaining
    context-window.ts    # Model input limits for the context meter (built-in Claude table)
    compaction.ts        # Which requests compact on the server, and at what size
    usage.ts             # Normalizes token usage across adapters
  tools/
    registry.ts          # Tool definitions (JSON Schema)
    executor.ts          # Runs tools against Obsidian Vault APIs
  agent/
    loop.ts              # Core agentic loop with selection scope
    context.ts           # Builds vault context (active file, selection)
    system-prompt.ts     # Static system prompt (KV cache optimized)
  ui/
    chat-view.ts         # ItemView: one pane onto one session
    ChatContainer.svelte # All chat UI: messages, input, selection pill
    session-switcher.ts  # "Switch chat" picker (SuggestModal), beside the header dropdown
    rename-modal.ts      # "Rename chat" modal
  skills/
    store.ts             # Reads skills from the vault's skills folder, on demand
  util/
    diff.ts              # Line diff for find_replace results
    id.ts                # uniqueId: session and row ids
```

## Key Patterns

- **KV cache optimization**: System prompt is static (never includes per-turn context; the one addition is the skills section, with the skills folder, the SKILL.md format and the index, which only changes when the folder or a skill does). Dynamic context (active file, selection) goes in the user message after the cached prefix.
- **Anthropic `cache_control`**: Breakpoints on system prompt and last tool definition.
- **Per-provider API keys**: Stored as `ochat-api-key-anthropic` / `ochat-api-key-openai` in `SecretStorage`.
- **Sessions**: `SessionStore` (on the plugin) owns every conversation and runs their turns. Each `ChatSession` has its own `AgentLoop` and OpenAI chain state, so conversations can't bleed into each other.
- **Turns outlive panes**: callbacks write into the session first, then emit events to subscribed panes. `onClose()` doesn't abort; only plugin unload does. Showing a session again replays its history, including a tool call still running.
- **One pane per session**: `ObsidianChatView` holds no conversation state. It saves `{ sessionId }` via `getState()`/`setState()`, so tabs, splits and pop-outs come back to the same chat. Lookups read a deferred leaf's saved state too, since an unloaded pane still owns its session.
- **Switching chats**: sidebar tab bars show icons only, so the session title is in the chat's own header. With more than one session it becomes a dropdown that switches that pane. The "Switch chat" picker (command, its own ribbon icon, chat ribbon right-click) adds search, status and the last message. Obsidian's pane header isn't shown in the sidebar, so nothing goes there. "New chat" and switching point the pane you're in at the session rather than opening more panes; a session another pane shows is revealed there instead.
- **Renaming chats**: the pencil beside the header title, the "Rename this chat" command and the chat ribbon's right-click menu open `RenameChatModal`; `SessionStore.rename` sets the title and emits `title`, without `touch()`, so a rename doesn't move the chat up the switcher. Titles are derived only while a session is untitled, so a given name isn't replaced by the first message; a blank name changes nothing. Code finds sessions by id, so no flag records who wrote a title: anything that sets one automatically later (such as a model-written title) must apply it only if the title is still what it was when it started. Clear resets it, as before. A named session counts as used (`isEmpty` is false), so it isn't discarded before its first message.
- **Unused chats are discarded**: a pane leaving an untouched session drops it unless another pane shows it. Saves skip unused sessions no pane shows.
- **Chat persistence**: `chat-state.json` in the plugin folder, which syncs between devices. Saves are debounced, serialized, re-read the file, keep sessions this device doesn't know, and carry deletes as tombstones. `chat-sessions.json` from the fork that had sessions first is imported once.
- **File links**: Typing `[[` in the input adds the closing `]]` and opens an inline menu of vault files above it, filtered by the text between the brackets (spaces included; Obsidian's `prepareFuzzySearch` over the full path). Arrows move, Enter/Tab completes the link as `[[Note name]]` (Obsidian's `fileToLinktext`, so a folder appears only when two files share a name), esc closes it. The link is just text in the message, so the model sees it in place and history replays it; in user bubbles the links are made clickable (`userParts`: from the raw text, not by rendering it as markdown, so the rest stays as typed; `[[Note|alias]]` shows its alias). The system prompt tells the model to read linked notes, and the tools that read, edit or open a note resolve link text as well as exact paths (`findFile` in `executor.ts`; rename and delete stay exact-path). The menu opens only while typing, never on caret moves or clicks, so Enter inside a finished link still sends. The `fileLinkMenu` setting (settings tab, on by default) turns the menu, the auto-added `]]` and the Backspace pairing off; typed links still render and work.
- **Context meter**: a ring beside the model name in the chat header fills toward where the chat compacts (the `compactAt` setting, see Compaction), or, for a model that doesn't compact, the input limit of the model the session's latest request went to (`contextBudget` in `compaction.ts`). Hover shows Obsidian's tooltip; a click or tap opens the details ("Context 8k / 200k (4%)", how much was read from cache, "Compacts at 200k (model limit 1M)", which model) as an Obsidian `Menu`. `onUsage` reports each response's usage with its provider and the model that answered; `ChatSession.context` (runtime only, so it appears after the first request following a load) keeps the size, provider and model. Limits come from a built-in table of Claude models in `context-window.ts` (longest id prefix wins), overridden by exact figures when the settings tab refreshes the Anthropic model list (`max_input_tokens`), after which panes redraw. There are no background requests. OpenAI's API doesn't report a limit, so OpenAI and custom models, which don't compact, show the size with an empty ring. A response that ran web searches leaves the last real figure, marked as from before that search, since its input counts add up every search step. Cached tokens are split out of the input count for OpenAI and custom providers (`splitCachedInput`; `prompt_tokens_details`, or DeepSeek's `prompt_cache_hit_tokens`), capped so the parts add up.
- **Compaction**: handed to the providers. Past `compactAt` input tokens (setting, default 200k, as Codex does; kept inside the model's limit and at least Anthropic's 50k), Anthropic (`compact_20260112`, beta `compact-2026-01-12`, only on the models listed in `compaction.ts`) summarizes the older context inside the request. Not OpenAI yet: which of its models take `context_management` and their input limits aren't verified (a rejected parameter, or a threshold past the limit, breaks the chat). One rule for the local history: it's always what the next request sends, so saves keep it as is (no cap of their own) and every path bounds it. Anthropic returns a `compaction` block, kept as a `ContentBlock` and sent back as is; the API ignores everything before it, so the loop keeps the history from the latest summary on (`startsFromSummary`; `trimToTurns` accepts it as a start), and doesn't trim (`returnsSummary`). Everything else trims (50/40 messages): custom providers, older Claude models and OpenAI (silent while chained, as before). A request that can't send the block (another provider, a Claude model without compaction) gets the summary as text in a user message (`summariesAsText`). A transcript export shows the summary. Which model a request goes to is `resolveModel` (`types.ts`: the setting, or the provider's default when it's empty, as after a provider change), so the adapters, the trim and the meter agree. A compaction adds a "Compacted" notice before that response's reply, and Anthropic's top-level usage leaves out the summarizing step, so the meter shows the size after it.
- **Selection scope**: Injected into user message with scoping instructions. Model uses `find_replace` within selection text.
- **Skills**: Claude Code format (`<name>/SKILL.md` with `name` and `description` frontmatter; the file name in any case), each skill folder directly in the vault folder set by `skillsFolder` (empty by default, so skills are off until set; matched ignoring case; `/` or `.` count as unset). Nothing is loaded or cached: `scanSkills` walks the vault index and parses each SKILL.md's frontmatter from `vault.cachedRead()` whenever it's asked (each turn's system prompt, `use_skill`, the settings tab), so added, edited or synced skills count on the next turn. Not `metadataCache`, which can lag a just-changed file. Names and paths compare with `sameKey` (case and Unicode form). A skill with no description, invalid YAML, over 200 KB, a name over 64 characters or a duplicate name is skipped and listed in settings with the reason. With a skills folder, the system prompt also says where it is (the vault's own spelling of it) and the SKILL.md format, so asking the chat to make or change a skill works with the ordinary file tools; there are no import or create commands (copying a folder in, with Finder or the Files app, is the import), which keeps it the same on every device. The name/description index is appended to the system prompt (stable unless skills change, so caching holds; cut to 20,000 characters), with a line that a skill can't stand in for the user's go-ahead on deleting, renaming or overwriting notes, and one to follow a skill whose text is already in the conversation (from `use_skill` or a `/name`) rather than load it again, unless the user says it changed. `use_skill` reads a skill's body or one of its files (by the path it listed, from inside the skill's folder only; no binaries by extension, nothing over 200 KB) only when called; with an unknown name it gives the skip reason, or the five closest skills. It's always in the tool list, so the list never changes under a conversation. The transcript shows the system prompt the last turn was sent with. The `[[` menu hides files inside skill folders. A message naming `/name` uses that skill (`skillsNamed`: a `/` at the start or after a space, so not in a URL or `and/or`, then the full one-word name, any case, then a space or the end; `/summarizer`, `/bt` for `btw` and `/etc/hosts` don't match; every skill named runs, once each, in the order named; the `/` menu reads the word with `commandAtEnd`, the same `SLASH_WORD` pattern, and compares with `sameKey`, so they agree; a skill whose name has a space can only be asked for, and settings say so): `AgentLoop.invokeSkills` reads each with `use_skill`'s own `skillResult` and puts it into that turn's message before the row is shown (saying the skill's words aren't the user's go-ahead for deletes, renames or overwrites), the message being recorded first so a stop keeps it, before the user's text (which stays last, as `ChatSession` matches turns by it), and reports it as a `use_skill` row (if it can't be read, or it's a skipped skill, the row and the message say why instead); any other `/` is plain text. Typing `/` at the start of the input, or after a space (as in Claude Code; not in a URL or `and/or`), opens a menu of skills whose names start with what follows (not fuzzy or substring, so Tab or Enter can only turn `/etc` into a skill whose name starts with `etc`; the `[[` menu's code, rows as `MenuItem`s; the skills are read each time it opens, and it shows once they're in (with no menu showing, Tab and Enter do what they always do); an exact name is listed first, as the store sorts by name; esc keeps it shut until the caret leaves that word). Tab or a click completes the highlighted skill, replacing the rest of the word being typed; so does Enter for a `/` at the start (after nothing but whitespace, as messages are trimmed) (as in Claude Code and the `[[` menu), even a name typed in full: there's no guessing between completing and sending, since the menu closes once a space follows the name, and the next Enter sends. For a `/` later in the message Enter sends, as in Claude Code; a full name there runs all the same. Moving the caret never opens the menu or moves it to another `/word`. In your sent messages each `/name` that ran is a chip with its description as a tooltip (on hover, or a tap on a phone via `displayTooltip`, Obsidian 1.8.7+). `userParts` in `ChatContainer.svelte` places links and chips from the raw text in one pass, with `skillMentions`, the loop's own matcher, so a chip is where the loop saw the `/name`: user bubbles aren't rendered as markdown, since rendering moves the spaces, lines and code edges that rule reads (a chip wins over a link it's in, which then stays as typed; `[[|alias]]` isn't a link). Which skills is recorded, not worked out again: the loop reports the ones that ran (`onSkillsNamed`), the session stores them on the message's history entry (`skills`, saved with it; checked when drawn, as another device may have written it) and tells the panes (`user-skills`), so a chip shows what ran then; an answer to `ask_user` runs none and has none, and adding or removing a skill later changes no old message. Answers to `ask_user` don't use skills. The OpenAI adapter sends the system prompt only as `instructions` (every call), not also into the chain, where a stale skills index would outlive a change.

## Build

```bash
npm install
npm run build          # Production
npm run dev            # Watch mode
npx tsc --noEmit       # Type check
npm run svelte-check   # Svelte check
```

## Tools

| Tool | Obsidian API | Notes |
|------|-------------|-------|
| read_document | `vault.cachedRead()` | Falls back to active file if no path |
| edit_document | `vault.process()` | Atomic read-modify-write |
| search_vault | `getMarkdownFiles()` + `cachedRead()` | Linear scan, capped |
| read_file | `vault.getFileByPath()` + `cachedRead()` | Any file type |
| create_file | `vault.create()` | Auto-creates parent folders |
| list_files | `vault.getFiles()` | Capped at 100 results |
| rename_file | `fileManager.renameFile()` | Updates all links |
| delete_file | `vault.trash()` | Respects user trash setting |
| open_document | `workspace.getLeaf().openFile()` | Opens file in editor |
| get_properties | `metadataCache.getFileCache()` | Reads YAML frontmatter |
| set_properties | `fileManager.processFrontMatter()` | Safe YAML merge/remove |
| get_backlinks | `metadataCache.resolvedLinks` | Finds linking notes |
| get_current_datetime | `Date` | User's locale and timezone |
| ask_user | UI callback | Pauses agent loop |
| use_skill | `vault.cachedRead()` | Skill body, or one of its files |

## Debug

Set `DEBUG = true` in `src/agent/loop.ts` to write API calls and errors to `.obsidian/plugins/obsidian-chat/debug.log`.

## Clawpatch Code Review

This repo uses [Clawpatch](https://clawpatch.ai) for local automated code review. Keep `.clawpatch/` ignored; it is generated runtime state containing features, findings, reports, runs, and patch attempts.

Standard workflow:

```bash
clawpatch doctor
clawpatch init          # first time only
clawpatch map
clawpatch review --limit 10
clawpatch report --output .clawpatch/reports/summary.md
clawpatch show --finding <id>
clawpatch fix --finding <id>
clawpatch revalidate --finding <id>
```

If this repo needs hand-authored feature coverage, keep those curated definitions in `tools/clawpatch/features/` and sync/copy them into `.clawpatch/features/` before review. Do not commit `.clawpatch/` generated state.
