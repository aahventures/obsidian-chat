// Mock OpenAI-compatible model for driving obsidian-chat in tests.
//
//   node mock-model.js <requests-dir> [port]
//
// Answers POST /v1/chat/completions and saves each request body as
// <requests-dir>/req-<n>.json, so a test can see exactly what the plugin sent
// (system prompt, tools, messages). Point the plugin's custom provider at
// http://127.0.0.1:<port> (default 8765).
//
// Replies to the last message:
// - a tool result:                  "MOCK: got tool result (<first 40 chars>)"
// - a user message containing
//   `call:<tool> <json args>`:       a tool call, e.g.
//                                     call:read_document {"path":"Notes/a.md"}
// - anything else:                  "MOCK reply #<n>"
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

let n = 0;
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      n++;
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        // Saved as-is below; a malformed request is itself worth seeing.
      }
      fs.writeFileSync(path.join(dir, `req-${n}.json`), JSON.stringify(body, null, 2) || raw);

      const messages = body.messages || [];
      const last = messages[messages.length - 1] || {};
      const text = String(last.content ?? "");
      const call = /call:(\w+)\s*(\{.*\})?/.exec(text);
      let message;
      if (last.role === "tool") {
        message = { role: "assistant", content: `MOCK: got tool result (${text.slice(0, 40).replace(/\n/g, " ")})` };
      } else if (call) {
        message = {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `call_${n}`, type: "function", function: { name: call[1], arguments: call[2] || "{}" } }],
        };
      } else {
        message = { role: "assistant", content: `MOCK reply #${n}` };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock model on http://127.0.0.1:${port}, saving requests to ${dir}`));
