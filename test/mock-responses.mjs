// A stand-in for the OpenAI Responses API, for tests only. Plays a fixed script of function calls and logs every request.
// Steps: {name, arguments} for one call, an array for parallel calls, or {sleep: ms}.
import http from "node:http";
import { appendFileSync } from "node:fs";
const [port, logFile, planJson] = process.argv.slice(2);
const plan = JSON.parse(planJson);
let step = 0, n = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    appendFileSync(logFile, JSON.stringify({ url: req.url, raw: body }) + "\n");
    if (!req.url.includes("/responses")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [], models: [] })); }
    let p = plan[step++];
    while (p && p.sleep) { await sleep(p.sleep); p = plan[step++]; }
    const id = "resp_" + ++n;
    const items = !p ? [{ type: "message", role: "assistant", id: "msg_" + n, content: [{ type: "output_text", text: "done", annotations: [] }] }]
      : (Array.isArray(p) ? p : [p]).map((c, i) => ({ type: "function_call", id: `fc_${n}_${i}`, call_id: c.call_id || `call_${n}_${i}`, name: c.name, arguments: JSON.stringify(c.arguments || {}) }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev("response.created", { response: { id } });
    items.forEach((item, i) => { ev("response.output_item.added", { output_index: i, item }); ev("response.output_item.done", { output_index: i, item }); });
    ev("response.completed", { response: { id, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } });
    res.end();
  });
}).listen(Number(port), "127.0.0.1");
