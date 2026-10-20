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
  skills/
    store.ts             # Reads skills from the vault's skills folder, on demand
  util/
    diff.ts              # Line diff for find_replace results
```

## Key Patterns

- **KV cache optimization**: System prompt is static (never includes per-turn context; the one addition is the skills index, which only changes when skills do). Dynamic context (active file, selection) goes in the user message after the cached prefix.
- **Anthropic `cache_control`**: Breakpoints on system prompt and last tool definition.
- **Per-provider API keys**: Stored as `ochat-api-key-anthropic` / `ochat-api-key-openai` in `SecretStorage`.
- **Sessions**: `SessionStore` (on the plugin) owns every conversation and runs their turns. Each `ChatSession` has its own `AgentLoop` and OpenAI chain state, so conversations can't bleed into each other.
- **Turns outlive panes**: callbacks write into the session first, then emit events to subscribed panes. `onClose()` doesn't abort; only plugin unload does. Showing a session again replays its history, including a tool call still running.
- **One pane per session**: `ObsidianChatView` holds no conversation state. It saves `{ sessionId }` via `getState()`/`setState()`, so tabs, splits and pop-outs come back to the same chat. Lookups read a deferred leaf's saved state too, since an unloaded pane still owns its session.
- **Switching chats**: sidebar tab bars show icons only, so the session title is in the chat's own header. With more than one session it becomes a dropdown that switches that pane. The "Switch chat" picker (command, its own ribbon icon, chat ribbon right-click) adds search, status and the last message. Obsidian's pane header isn't shown in the sidebar, so nothing goes there. "New chat" and switching point the pane you're in at the session rather than opening more panes; a session another pane shows is revealed there instead.
- **Unused chats are discarded**: a pane leaving an untouched session drops it unless another pane shows it. Saves skip unused sessions no pane shows.
- **Chat persistence**: `chat-state.json` in the plugin folder, which syncs between devices. Saves are debounced, serialized, re-read the file, keep sessions this device doesn't know, and carry deletes as tombstones. `chat-sessions.json` from the fork that had sessions first is imported once.
- **File links**: Typing `[[` in the input adds the closing `]]` and opens an inline menu of vault files above it, filtered by the text between the brackets (spaces included; Obsidian's `prepareFuzzySearch` over the full path). Arrows move, Enter/Tab completes the link as `[[Note name]]` (Obsidian's `fileToLinktext`, so a folder appears only when two files share a name), esc closes it. The link is just text in the message, so the model sees it in place and history replays it; user bubbles containing `[[` render as markdown so the links are clickable. The system prompt tells the model to read linked notes, and the tools that read, edit or open a note resolve link text as well as exact paths (`findFile` in `executor.ts`; rename and delete stay exact-path). The menu opens only while typing, never on caret moves or clicks, so Enter inside a finished link still sends. The `fileLinkMenu` setting (settings tab, on by default) turns the menu, the auto-added `]]` and the Backspace pairing off; typed links still render and work.
- **Selection scope**: Injected into user message with scoping instructions. Model uses `find_replace` within selection text.
- **Skills**: Claude Code format (`<name>/SKILL.md` with `name` and `description` frontmatter; the file name in any case), each skill folder directly in the vault folder set by `skillsFolder` (empty by default, so skills are off until set; matched ignoring case; `/` or `.` count as unset). Nothing is loaded or cached: `scanSkills` walks the vault index and parses each SKILL.md's frontmatter from `vault.cachedRead()` whenever it's asked (each turn's system prompt, `use_skill`, the settings tab), so added, edited or synced skills count on the next turn. Not `metadataCache`, which can lag a just-changed file. Names and paths compare with `sameKey` (case and Unicode form). A skill with no description, invalid YAML, over 200 KB, a name over 64 characters or a duplicate name is skipped and listed in settings with the reason. The name/description index is appended to the system prompt (stable unless skills change, so caching holds; cut to 20,000 characters), with a line that a skill can't stand in for the user's go-ahead on deleting, renaming or overwriting notes. `use_skill` reads a skill's body or one of its files (by the path it listed, from inside the skill's folder only; no binaries by extension, nothing over 200 KB) only when called; with an unknown name it gives the skip reason, or the five closest skills. It's always in the tool list, so the list never changes under a conversation. The transcript shows the system prompt the last turn was sent with. The `[[` menu hides files inside skill folders. The OpenAI adapter sends the system prompt only as `instructions` (every call), not also into the chain, where a stale skills index would outlive a change.

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
