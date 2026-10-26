# Obsidian Chat

An agentic AI chat plugin for Obsidian. Two providers, best models, no bloat.

<p align="center">
  <img src="assets/screenshot-mobile.jpeg" alt="Obsidian Chat on mobile" width="300">
</p>

## Philosophy

Existing AI plugins for Obsidian are overcomplicated, break on mobile, or require a dozen settings to configure. Obsidian Chat takes the opposite approach: pick a provider, enter your API key, and start talking. The AI reads your notes, makes edits, creates files, and asks clarifying questions, all through a simple chat interface.

Mobile is a first-class citizen, not an afterthought.

## Providers

| Provider | Default Model | Features |
|----------|--------------|----------|
| Anthropic | Claude Sonnet 4.6 | Adaptive thinking, web search, prompt caching |
| OpenAI | Codex 5.3 | Responses API, reasoning, web search |

That's it. Two providers. The best models. Fetch the full model list from the API with the refresh button if you want something different.

## What the AI can do

The chat assistant has 15 tools that map directly to Obsidian's Vault API:

- **read_document** / **read_file**: Read any note in your vault
- **edit_document**: Find-and-replace, insert, or replace content
- **search_vault**: Search filenames and content
- **create_file**: Create new notes with suggested paths
- **rename_file**: Rename or move files (updates all links)
- **delete_file**: Move files to trash
- **list_files**: Browse vault structure
- **open_document**: Navigate to a file in the editor
- **get_properties**: Read YAML frontmatter as structured data
- **set_properties**: Update frontmatter properties (uses Obsidian's native API)
- **get_backlinks**: Find all notes that link to a given document
- **get_current_datetime**: Get the current date and time in the user's locale
- **ask_user**: Ask you a question when something is ambiguous
- **use_skill**: Load one of your skills

The AI reads before it edits, prefers surgical find-and-replace over full rewrites, and acts on your confirmations without re-asking.

## Selection scope

Select text in a note, right-click, and choose "Send selection to Chat". The selection appears as a pill above the input. The AI works only within that selection, leaving the rest of the document untouched. Dismiss the pill to go back to full-document mode.

## Skills

Skills are saved instructions for a kind of task, in Claude Code's format: a folder per skill with a `SKILL.md` that has a `name` and `description` in its frontmatter.

- **Where they live**: a folder in your vault (set it in Settings > Skills folder, for example `Skills`; skills are off until you do), one folder per skill, directly in it (as in Claude Code: a skill one folder deeper isn't found). It syncs like any note, so skills work on mobile too. Changes count from your next message; there's nothing to reload. Settings list the skills found, and any that couldn't be read.
- **Using one**: just ask. The chat sees every skill's name and description (up to about 20,000 characters of them; past that, the rest aren't listed), and loads one whose description matches your request.
- **Asking for one by name**: write `/` and the skill's name, at the start of your message or anywhere after a space, as in `/write-in-my-voice draft a reply to Sam` or `draft a reply to Sam /write-in-my-voice`. It runs only for the full name (`/write` alone runs nothing); name several and each runs. Typing `/` opens a menu of your skills: Tab fills in the highlighted one. At the start, Enter does too (even a name you typed in full), and the next Enter sends; later in a message, Enter sends. The skill goes in with that message, and the chat shows it was used: in your message each `/name` that ran is highlighted (hover for its description), so a name that didn't count (`/write`, or `/btw.` with a full stop) stays plain. A `/` that doesn't name a skill (`/etc/hosts`) is sent as you typed it. A name is one word, as in Claude Code: a skill whose name has a space (one with no `name`, named after a folder like `Meeting notes`) can't be typed this way, but you can still ask for it.
- **Adding skills**: a skill is just a folder, so copy it into the skills folder. On a computer, drag it in (Finder, Explorer, or Obsidian's file list). On a phone, use the Files app: your vault is a folder there. A `.zip` (as claude.ai downloads skills) needs unzipping first (on iPhone, tap it in Files); check that `SKILL.md` ends up directly in the skill's folder, since a skill one folder deeper isn't found. From Claude Code, copy the folders in `~/.claude/skills`. Or ask the chat to make one ("make a skill that turns meeting notes into action items"): it knows the format and where skills go.
- **Scripts don't run.** The chat follows a skill's instructions and can read its other files, but a skill that depends on its scripts only partly works.

## Install

### Via BRAT (recommended for now)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. In BRAT settings, click "Add Beta plugin"
3. Enter: `omarshahine/obsidian-chat`
4. Enable the plugin in Community Plugins

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create `<vault>/.obsidian/plugins/obsidian-chat/`
3. Copy the files there
4. Enable in Community Plugins

## Setup

1. Open Settings > Obsidian Chat
2. Pick Anthropic or OpenAI
3. Enter your API key (stored per-provider in your OS keychain via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage), never synced)
4. Click the refresh icon next to Model to load available models
5. Open the chat from the ribbon icon, command palette, or context menu

## Commands

| Command | Description |
|---------|-------------|
| Open chat | Open the chat sidebar |
| New chat | Start a new session, leaving existing ones intact |
| Chat about this note | Send the active note to chat (editor required) |
| Send selection to Chat | Send selected text with scoped context |
| Copy conversation transcript | Export the active session's conversation to clipboard |
| Clear conversation | Empty the active session (keeps the session) |
| Rename this chat | Give the focused chat a name of your own |

## Chat sessions

Multiple conversations can be open at once. Each keeps its own transcript and
its own agent state, so context never carries between them.

- **New chat** starts a session; existing ones keep their history.
- Once more than one session exists, a dropdown appears in the chat header to
  switch between them. Sessions are named after their first message.
- **Rename** a chat with the pencil beside its name in the header, the
  "Rename this chat" command, or the ribbon icon's right-click menu. A name
  you give stays until the chat is cleared.
- Sessions are **not** scoped to a note — a chat can range across the whole
  vault, which is the point of the plugin. "Chat about this note" and "Send
  selection to Chat" start a new session rather than interrupting the one
  you are in.
- Switching is blocked while a response is streaming, so a reply always lands
  in the conversation that asked for it.
- The 20 most recently used sessions are kept; older ones are dropped.

## Context menus

- **File explorer**: Right-click any markdown file > "Chat about this note"
- **Editor**: Right-click selected text > "Send selection to Chat"
- **Ribbon icon**: Right-click for quick actions menu

## Design decisions

| Decision | Why |
|----------|-----|
| Two providers only | Simplicity. Anthropic and OpenAI cover the best models. |
| No streaming | Obsidian's `requestUrl()` doesn't support it. Required for mobile. |
| Conversation persistence | Chat history survives Obsidian restarts. Stored locally in `chat-state.json`, never synced. |
| No vault indexing | Linear search capped at results limit. Avoids mobile memory issues. |
| Svelte 5 UI | Compiles away to vanilla JS. Reactive state without React's runtime overhead. |
| Right sidebar on mobile | Slides in from the edge, keeping your document underneath. |
| Per-device API keys | Stored in OS keychain via [SecretStorage](https://docs.obsidian.md/plugins/guides/secret-storage). Never synced, never in data.json. |

## Development

```bash
git clone https://github.com/omarshahine/obsidian-chat.git
cd obsidian-chat
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

Symlink into your vault for testing:

```bash
ln -s /path/to/obsidian-chat /path/to/vault/.obsidian/plugins/obsidian-chat
```

## License

MIT
