// Mock OpenAI-compatible model for driving obsidian-chat in tests.
//
//   node mock-model.js <requests-dir> [port]
//
// Answers POST /v1/chat/completions and saves each request body as
// <requests-dir>/req-<n>.json, so a test can see exactly what the plugin sent
// (system prompt, tools, messages). req-*.json files left from an earlier run
// are removed at startup, so every file there is from this run. Point the
// plugin's custom provider at http://127.0.0.1:<port> (default 8765). Every
// other route gets a 404, and a body that isn't JSON with a messages array
// gets a 400, as a real server would; neither is counted, so they can't
// shift the numbering (a 400's body is still saved, as req-bad-<k>.json).
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
for (const f of fs.readdirSync(dir)) {
  if (/^req-.*\.json$/.test(f)) fs.rmSync(path.join(dir, f));
}

// `\r?` so a message with Windows line endings still scripts calls.
const CALL_LINE = /^call:(\w+)[ \t]*(\{.*\})?[ \t]*\r?$/gm;

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
let bad = 0;

function send(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
    // A client that drops mid-request (Obsidian relaunched or a plugin
    // reload) must not take the server down with an unhandled 'error'.
    req.on("error", (e) => console.error(`request error: ${e.message}`));
    res.on("error", (e) => console.error(`response error: ${e.message}`));
    // Decode as a stream, so a multi-byte character split across chunks survives.
    req.setEncoding("utf8");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
          console.log(`404 ${req.method} ${req.url}`);
          send(res, 404, { error: { message: "mock-model only serves POST /v1/chat/completions" } });
          return;
        }
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          // Answered with a 400 below, and saved as sent: it's worth seeing.
        }
        if (!Array.isArray(body?.messages)) {
          bad++;
          save(`req-bad-${bad}.json`, raw);
          console.error(`400: request body isn't JSON with a messages array (saved as req-bad-${bad}.json)`);
          send(res, 400, { error: { message: "request body must be JSON with a messages array" } });
          return;
        }
        n++;
        save(`req-${n}.json`, JSON.stringify(body, null, 2));
        const message = reply(body.messages, n);
        send(res, 200, {
          choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      } catch (e) {
        // Never let one odd request take the server down mid-test.
        console.error(`error handling request: ${e.stack || e}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(e) } }));
      }
    });
  });

function save(name, content) {
  try {
    fs.writeFileSync(path.join(dir, name), content);
  } catch (e) {
    console.error(`couldn't save ${name}: ${e.message}`);
  }
}

// Say so plainly if the port is taken: started in the background, an old mock
// would otherwise keep answering while this one has quietly exited.
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `port ${port} is already in use (an earlier mock still running?); stop it or pass another port`
      : `server error: ${e.message}`
  );
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}, saving requests to ${dir}`));
