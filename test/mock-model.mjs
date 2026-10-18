// A stand-in for the model API, for tests only. It plays a fixed script of tool calls and logs every request.
// Steps: {name, input} for one tool call, an array of them for parallel calls, {sleep: ms}, or {usage_limit: true}.
import http from "node:http";
import { appendFileSync } from "node:fs";
const [port, logFile, planJson] = process.argv.slice(2);
const plan = JSON.parse(planJson);
let step = 0, n = 0, ids = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function sse(res, blocks, stop) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev("message_start", { message: { id: "msg_" + ++n, type: "message", role: "assistant", model: "mock", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === "text") { ev("content_block_start", { index: i, content_block: { type: "text", text: "" } }); ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text } }); }
    else { ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }); ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } }); }
    ev("content_block_stop", { index: i });
  });
  ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  ev("message_stop", {});
  res.end();
}
http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 1 })); }
    const b = JSON.parse(body || "{}");
    const tools = (b.tools || []).map(t => t.name);
    const main = tools.length > 0;
    const results = (b.messages || []).flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === "tool_result").map(c => ({ id: c.tool_use_id, is_error: !!c.is_error, text: typeof c.content === "string" ? c.content : JSON.stringify(c.content) }));
    appendFileSync(logFile, JSON.stringify({ main, tools, raw: body, results }) + "\n");
    const reply = (blocks, stop) => b.stream ? sse(res, blocks, stop) : (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify({ id: "msg_" + ++n, type: "message", role: "assistant", model: "mock", content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })));
    if (!main) return reply([{ type: "text", text: "ok" }], "end_turn");
    let p = plan[step];
    while (p && p.sleep) { await sleep(p.sleep); p = plan[++step]; }
    // A plan's usage limit: every later request is refused the way a subscription limit is.
    if (p && p.usage_limit) { res.writeHead(429, { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600), "retry-after": "3600" }); return res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached for this plan." } })); }
    step++;
    if (!p) return reply([{ type: "text", text: "done" }], "end_turn");
    const calls = (Array.isArray(p) ? p : [p]).map(c => ({ type: "tool_use", id: c.id || "toolu_" + ++ids, name: c.name, input: c.input || {} }));
    reply(calls, "tool_use");
  });
}).listen(Number(port), "127.0.0.1");
