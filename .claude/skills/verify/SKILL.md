---
name: verify
description: Run the plugin inside real Obsidian (headless, under xvfb) against a test vault and a mock model server, and drive it over CDP with Playwright.
---

# Verify obsidian-chat in real Obsidian

Worked in a cloud container (Linux, no FUSE, no Obsidian account, no real API key) with Obsidian 1.13.7.

**Needs:** Linux x86_64 (the AppImage), `xvfb-run`, Node, and Playwright with a Chromium. Claude Code's cloud containers have all of these; Playwright is at `/opt/node-tools/node_modules/playwright`. Anywhere else, install it into a scratch folder (`npm i playwright` there) and import it from there; it connects to Obsidian's own Chromium over CDP, so no browser download is needed. On macOS or Windows, launching the installed Obsidian with `--remote-debugging-port=9333` (a standard Electron flag) instead of steps 2 and 5, without xvfb, should work, but is untested.

## Setup
1. `npm ci && npm run build` (produces `main.js`).
2. Download Obsidian: `curl -L -o Obsidian.AppImage https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7/Obsidian-1.13.7.AppImage`.
   GitHub release downloads work through the proxy; obsidian.md and the GitHub API don't. Then `chmod +x` it and run `./Obsidian.AppImage --appimage-extract` (there's no FUSE).
3. Use an isolated `HOME`, so Obsidian's config and anything the plugin reads from `~` are test copies:
   - `$HOME/.config/obsidian/obsidian.json`: `{"vaults":{"testvault0001":{"path":"<vault>","ts":<ms>,"open":true}}}`
   - In the vault: `.obsidian/community-plugins.json` = `["obsidian-chat"]`, the plugin files (`main.js`, `manifest.json`, `styles.css`) in `.obsidian/plugins/obsidian-chat/`, and a `data.json` with `{"provider":"custom","baseUrl":"http://127.0.0.1:8765","model":"mock"}`.
4. Mock model: `node .claude/skills/verify/mock-model.js <requests-dir>` (from the repo). It answers the custom provider's `POST /v1/chat/completions` and saves each request body as `<requests-dir>/req-<n>.json`, which shows the exact system prompt, tools and messages the plugin sent. Other routes get a 404 and aren't counted. To script tool calls, put lines starting with `call:<tool> <json args>` in a chat message (e.g. `call:read_document {"path":"Notes/a.md"}`); several lines are returned one per round, so multi-step tool use can be tested. See the file's header. In the chat input, Shift+Enter starts a new line.
5. Launch: `HOME=<home> xvfb-run -a -s "-screen 0 1280x900x24" ./squashfs-root/obsidian --no-sandbox --disable-gpu --remote-debugging-port=9333 &`, then wait until `curl -s localhost:9333/json/list` lists an `app://` page.

## Drive
- With Playwright (see **Needs**): `chromium.connectOverCDP("http://localhost:9333")`, then take the page whose URL starts with `app://`.
- The first open asks "Do you trust the author of this vault?". Click "Trust author and enable plugins".
- Settings: `app.setting.open(); app.setting.openTabById("obsidian-chat")`, run in the main page. In 1.13 Settings opens in **its own window**: a second CDP page (URL `about:blank`, title "Settings - …"). Find it with `context.pages()` and drive the settings UI there. Close it with `app.setting.close()` from the main page.
- The custom provider needs an API key: fill the password field in the plugin's settings tab (any string works). It's kept in `app.secretStorage`, so it survives plugin reloads.
- To load a rebuilt `main.js` without relaunching: copy it into the plugin folder, then `await app.plugins.disablePlugin("obsidian-chat"); await app.plugins.enablePlugin("obsidian-chat")`.
- Chat: `app.commands.executeCommandById("obsidian-chat:open-chat")`. The input is `textarea.ochat-input`, input menu rows are `.ochat-mention-item`, and chat bubbles are `.ochat-msg`. Give the first message after opening the pane a few seconds before reading the reply.
- To simulate sync, write vault files with `fs` directly. Obsidian's file watcher turns that into vault events.

## Gotchas
- Errors in Obsidian's log about dbus, the update check or certificates come from the environment, not the plugin.
- Don't `pkill -f` on a pattern that also appears in your own shell command; it kills the shell. Find the PIDs with `ps` and kill those.
- Older Obsidian (1.9.x) has no `app.secretStorage`: the key then lives only in memory and must be filled again after every relaunch or plugin reload, or "Open chat" just shows an API key notice.
