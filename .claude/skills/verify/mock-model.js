// Mock OpenAI-compatible model for driving obsidian-chat in tests.
//
//   node mock-model.js <requests-dir> [port]
//
// Answers POST /v1/chat/completions and saves each request body as
// <requests-dir>/req-<n>.json, so a test can see exactly what the plugin sent
// (system prompt, tools, messages). Point the plugin's custom provider at
// http://127.0.0.1:<port> (default 8765). Every other route gets a 404, and
// isn't saved or counted, so it can't shift the numbering.
//
// Scripting tool calls: put one or more lines in your chat message that start
// with `call:<tool> <json args>`, e.g.
//
//   call:read_document {"path":"Notes/a.md"}
//   call:edit_document {"path":"Notes/a.md","operation":"insert","content":"hi","position":"end"}
//
// The mock returns them one per round, in order: the first as the reply to
// your message, the next after the first tool result, and so on. Once they're
// used up it replies "MOCK: done after <k> tool calls (<last result>)". A
// message with no call: lines gets "MOCK reply #<n>". Only whole lines count,
// so text quoted or prefixed by the plugin (a selection, the context line)
// can't trigger a call by accident.
const http = require("http");
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
const port = Number(process.argv[3] || 8765);
if (!dir) {
  console.error("usage: node mock-model.js <requests-dir> [port]");
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

const CALL_LINE = /^call:(\w+)[ \t]*(\{.*\})?[ \t]*$/gm;

/** The scripted calls in a user message, in order. */
function scriptedCalls(text) {
  return [...text.matchAll(CALL_LINE)].map((m) => ({ name: m[1], args: m[2] || "{}" }));
}

function reply(messages, n) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const user = lastUser >= 0 ? messages[lastUser] : null;
  const calls = scriptedCalls(typeof user?.content === "string" ? user.content : "");
  const results = messages.slice(lastUser + 1).filter((m) => m && m.role === "tool");
  if (results.length < calls.length) {
    const c = calls[results.length];
    return {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${n}`, type: "function", function: { name: c.name, arguments: c.args } }],
    };
  }
  if (results.length > 0) {
    const last = String(results[results.length - 1].content ?? "").slice(0, 40).replace(/\n/g, " ");
    return { role: "assistant", content: `MOCK: done after ${results.length} tool calls (${last})` };
  }
  return { role: "assistant", content: `MOCK reply #${n}` };
}

let n = 0;
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
          console.log(`404 ${req.method} ${req.url}`);
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: `mock-model only serves POST /v1/chat/completions` } }));
          return;
        }
        n++;
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          // Saved as sent below: a malformed request is itself worth seeing.
        }
        try {
          const saved = body !== null && typeof body === "object" ? JSON.stringify(body, null, 2) : raw;
          fs.writeFileSync(path.join(dir, `req-${n}.json`), saved);
        } catch (e) {
          console.error(`couldn't save request ${n}: ${e.message}`);
        }
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const message = reply(messages, n);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      } catch (e) {
        // Never let one odd request take the server down mid-test.
        console.error(`error handling request: ${e.stack || e}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(e) } }));
      }
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}, saving requests to ${dir}`));
