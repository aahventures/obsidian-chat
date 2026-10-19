// Mock OpenAI-compatible model for driving obsidian-chat in tests.
//
//   node mock-model.js <requests-dir> [port]
//
// Answers POST /v1/chat/completions and saves each request body as
// <requests-dir>/req-<n>.json, so a test can see exactly what the plugin sent
// (system prompt, tools, messages). Once it has the port, it removes the
// req-<n>.json and req-bad-<n>.json files an earlier run left (only those
// names), so every such file there is from this run. Point the plugin's
// custom provider at http://127.0.0.1:<port> (default 8765).
//
// GET /v1/models lists one model, "mock", so the settings tab's model refresh
// works. Every other route gets a 404. Like a real server, it answers 400 to a
// body that isn't JSON with a messages array, and to a history where an
// assistant tool call has no matching tool result (or a tool result answers no
// call). A 400's body is saved as req-bad-<k>.json. Neither 404s nor 400s are
// counted, so they can't shift the numbering.
//
// Scripting tool calls: put one or more lines in your chat message that start
// with `call:<tool> <json args>`, each call on one line, e.g.
//
//   call:read_document {"path":"Notes/a.md"}
//   call:edit_document {"path":"Notes/a.md","operation":"insert","content":"hi","position":"end"}
//
// The mock returns them one per round, in order: the first as the reply to
// your message, the next after the first tool result, and so on. Once they're
// used up it replies "MOCK: done after <k> tool calls (<last result>)". A
// message with no call: lines gets "MOCK reply #<n>". A line starting with
// `call:` that doesn't parse gets "MOCK: couldn't parse call line: ...", so a
// scripting slip doesn't look like a plugin that never ran the tool.
//
// Only what you typed is read: the plugin's own blocks before it (the
// "[Context: ...]" line, which can hold your editor selection, and the
// selection-scope block) are skipped, so selected text can't script a call.
//
// Limits: one tool call per round (parallel calls in one response aren't
// produced), and the plugin stops a turn after its max tool iterations (20 by
// default), so script fewer calls than that.
const http = require("http");
const fs = require("fs");
const path = require("path");

const USAGE = "usage: node mock-model.js <requests-dir> [port]";
const dir = process.argv[2];
const portArg = process.argv[3] ?? "8765";
const port = Number(portArg);
if (!dir) {
  console.error(USAGE);
  process.exit(1);
}
if (!/^\d+$/.test(portArg) || port < 1 || port > 65535) {
  console.error(`port must be a number from 1 to 65535, got "${portArg}"\n${USAGE}`);
  process.exit(1);
}

/** Tool call ids carry a per-run prefix, so they never repeat ids saved in earlier chats. */
const RUN = Date.now().toString(36);
const CALL_LINE = /^call:(\w+)[ \t]*(\{.*\})?[ \t]*$/;
const OWN_FILE = /^req-(bad-)?\d+\.json$/;

/** The part of a user message the person typed, without the plugin's blocks before it. */
function typedPart(content) {
  let text = content;
  // buildContextMessage: one "[Context: ... ]" block, whose selection (up to
  // 200 characters, newlines and all) sits inside `Selected text: "...".`
  const context = /^\[Context: [^\n]*?(?:Selected text: "[\s\S]{0,203}?"\.\s)?\]\n\n/.exec(text);
  if (context) text = text.slice(context[0].length);
  // The selection-scope block: a note, then the selection quoted with "> ".
  const scope = /^\[Selection scope: [^\n]*\]\n\nSelected text:\n(?:> [^\n]*\n)*\n/.exec(text);
  if (scope) text = text.slice(scope[0].length);
  return text;
}

/** The scripted calls in what the person typed, in order, plus any call: lines that didn't parse. */
function scriptedCalls(content) {
  const calls = [];
  const broken = [];
  for (const line of typedPart(content).split(/\r?\n/)) {
    if (!line.startsWith("call:")) continue;
    const m = CALL_LINE.exec(line);
    if (m) calls.push({ name: m[1], args: m[2] || "{}" });
    else broken.push(line);
  }
  return { calls, broken };
}

/** Why a real server would reject this history's tool calls, or null if it wouldn't. */
function toolPairingError(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "tool") return `tool message ${i} answers no preceding tool call`;
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const wanted = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    for (; j < messages.length && messages[j]?.role === "tool"; j++) {
      if (!wanted.delete(messages[j].tool_call_id)) {
        return `tool message ${j} has tool_call_id ${JSON.stringify(messages[j].tool_call_id)}, which the assistant message before it didn't call`;
      }
    }
    if (wanted.size > 0) return `assistant message ${i} has tool calls with no tool result: ${[...wanted].join(", ")}`;
    i = j - 1;
  }
  return null;
}

function reply(messages, n) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  const content = messages[lastUser]?.content;
  const { calls, broken } = scriptedCalls(typeof content === "string" ? content : "");
  const results = messages.slice(lastUser + 1).filter((m) => m?.role === "tool");
  if (broken.length > 0) {
    console.error(`couldn't parse call line(s): ${broken.join(" | ")}`);
    return { role: "assistant", content: `MOCK: couldn't parse call line: ${broken[0]}` };
  }
  if (results.length < calls.length) {
    const c = calls[results.length];
    return {
      role: "assistant",
      content: "",
      tool_calls: [{ id: `call_${RUN}_${n}`, type: "function", function: { name: c.name, arguments: c.args } }],
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

function save(name, content) {
  try {
    fs.writeFileSync(path.join(dir, name), content);
  } catch (e) {
    console.error(`couldn't save ${name}: ${e.message}`);
  }
}

function reject(res, raw, why) {
  bad++;
  save(`req-bad-${bad}.json`, raw);
  console.error(`400: ${why} (saved as req-bad-${bad}.json)`);
  send(res, 400, { error: { message: why } });
}

function handle(req, res, raw) {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    send(res, 200, { object: "list", data: [{ id: "mock", object: "model", owned_by: "mock-model" }] });
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    console.log(`404 ${req.method} ${req.url}`);
    send(res, 404, { error: { message: "mock-model only serves POST /v1/chat/completions and GET /v1/models" } });
    return;
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Rejected below, and saved as sent: it's worth seeing.
  }
  if (!Array.isArray(body?.messages)) {
    reject(res, raw, "request body must be JSON with a messages array");
    return;
  }
  const pairing = toolPairingError(body.messages);
  if (pairing) {
    reject(res, JSON.stringify(body, null, 2), pairing);
    return;
  }
  n++;
  save(`req-${n}.json`, JSON.stringify(body, null, 2));
  const message = reply(body.messages, n);
  send(res, 200, {
    choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
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
      handle(req, res, raw);
    } catch (e) {
      // Never let one odd request take the server down mid-test.
      console.error(`error handling request: ${e.stack || e}`);
      if (res.headersSent) res.end();
      else send(res, 500, { error: { message: String(e) } });
    }
  });
});

// Say so plainly if the port is taken: started in the background, an old mock
// would otherwise keep answering while this one has quietly exited.
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? `port ${port} is already in use (an earlier mock still running?). Stop it, or pass another port and change the plugin's Base URL to match.`
      : `server error: ${e.message}`
  );
  process.exit(1);
});

// Clear the last run's files only once the port is ours, so a second launch
// that can't start never deletes files a running mock is still writing.
server.listen(port, "127.0.0.1", () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (OWN_FILE.test(f)) fs.rmSync(path.join(dir, f));
  }
  console.log(`mock model on http://127.0.0.1:${port}, saving requests to ${dir}`);
});
