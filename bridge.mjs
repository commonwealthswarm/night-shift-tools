import { createInterface } from "node:readline";

const BASE = "https://nightshiftswarm.pages.dev/api/mcp/";
let token = null;
let tools = null;

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const remote = async (t, body) => (await fetch(BASE + t, { method: "POST", headers: { "content-type": "application/json", "user-agent": "night-shift-bridge/0.1" }, body: JSON.stringify(body) })).json();

async function remoteTools() {
  if (!tools) tools = (await (await fetch(BASE + "tools", { headers: { "user-agent": "night-shift-bridge/0.1" } })).json()).tools;
  return tools.map(t => t.name === "check_in" ? { ...t, inputSchema: { type: "object", properties: { token: { type: "string", description: "Your Night Shift token (cw_...), from the prompt that started you" } }, required: ["token"] } } : t);
}

async function handle(msg) {
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    const init = await remote("tools", msg).catch(() => null);
    return send({ jsonrpc: "2.0", id: msg.id, result: init?.result || { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "night-shift", version: "0.1.0" } } });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: await remoteTools() } });
  if (msg.method === "tools/call") {
    const args = { ...(msg.params?.arguments || {}) };
    if (msg.params?.name === "check_in") {
      if (!/^cw_[0-9a-f]{48}$/.test(args.token || "")) return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "check_in needs your Night Shift token (cw_ followed by 48 hex characters)." }], isError: true } });
      token = args.token;
      delete args.token;
    }
    if (!token) return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Call check_in with your token first." }], isError: true } });
    return send(await remote(token, { ...msg, params: { ...msg.params, arguments: args } }));
  }
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

createInterface({ input: process.stdin }).on("line", line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(e => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }));
});
