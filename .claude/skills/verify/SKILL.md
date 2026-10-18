---
name: verify
description: Run the plugin inside real Obsidian (headless, under xvfb) against a test vault and a mock model server, and drive it over CDP with Playwright.
---

# Verify obsidian-chat in real Obsidian

Worked in a cloud container (Linux, no FUSE, no Obsidian account, no real API key).

## Setup
1. `npm ci && npm run build` (produces `main.js`).
2. Download Obsidian: `curl -L -o Obsidian.AppImage https://github.com/obsidianmd/obsidian-releases/releases/download/v1.9.14/Obsidian-1.9.14.AppImage`.
   GitHub release downloads work through the proxy; obsidian.md and the GitHub API don't. Then `chmod +x` it and run `./Obsidian.AppImage --appimage-extract` (there's no FUSE).
3. Use an isolated `HOME`, so `~/.claude/skills` and Obsidian's config are test copies:
   - `$HOME/.config/obsidian/obsidian.json`: `{"vaults":{"testvault0001":{"path":"<vault>","ts":<ms>,"open":true}}}`
   - In the vault: `.obsidian/community-plugins.json` = `["obsidian-chat"]`, the plugin files in `.obsidian/plugins/obsidian-chat/`, and a `data.json` with `"provider":"custom","baseUrl":"http://127.0.0.1:8765","model":"mock"`.
4. Mock model: a small Node HTTP server that answers `POST /v1/chat/completions` in Chat Completions format and writes each request body to a file. That shows the exact system prompt, tools and user message the plugin sends. Return `tool_calls` for a trigger phrase to exercise tools.
5. Launch: `HOME=<home> xvfb-run -a -s "-screen 0 1280x900x24" ./squashfs-root/obsidian --no-sandbox --disable-gpu --remote-debugging-port=9333 &`

## Drive
- Use Playwright from `/opt/node-tools/node_modules/playwright`: `chromium.connectOverCDP("http://localhost:9333")`, then take the page whose URL starts with `app://`.
- The first open asks "Do you trust the author of this vault?". Click "Trust author and enable plugins".
- The custom provider needs an API key: fill the password field in the plugin's settings tab (any string works).
- Settings: `app.setting.open(); app.setting.openTabById("obsidian-chat")`. Close with `app.setting.close()`, because Escape inside a text field doesn't close it.
- Chat: `app.commands.executeCommandById("obsidian-chat:open-chat")`. The input is `textarea.ochat-input`, input menu rows are `.ochat-mention-item`, and chat bubbles are `.ochat-msg`.
- To simulate sync, write vault files with `fs` directly. Obsidian's file watcher turns that into vault events.

## Gotchas
- Errors in Obsidian's log about dbus, the update check or certificates come from the environment, not the plugin.
- Don't `pkill -f` on a pattern that also appears in your own shell command; it kills the shell. Find the PIDs with `ps` and kill those.
