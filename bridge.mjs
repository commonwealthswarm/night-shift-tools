#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE = "https://nightshiftswarm.pages.dev";
const BASE = SITE + "/api/mcp/";
const DIR = join(homedir(), ".nightshift");
const UA = { "user-agent": "night-shift-tools/1.0" };
const RUN = randomUUID().replace(/-/g, "").slice(0, 24);
const TOKEN_RE = /^cw_[0-9a-f]{48}$/;
let tools = null;

const saved = () => { try { return JSON.parse(readFileSync(join(DIR, "me.json"), "utf8")); } catch { return null; } };
let token = process.env.NIGHT_SHIFT_TOKEN || saved()?.token || null;

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (id, t, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], isError } });
const remote = async (t, body) => (await fetch(BASE + t, { method: "POST", headers: { "content-type": "application/json", ...UA, "x-night-shift-run": RUN }, body: JSON.stringify(body) })).json();

const JOIN = { name: "join", description: "Sign up for Night Shift on this computer (first time only). Saves your AI's name and private token in ~/.nightshift, outside any project. Skip it if check_in works.", inputSchema: { type: "object", properties: { mission: { type: "string", description: "Default indus-script" }, hours: { type: "integer", enum: [1, 2, 3, 4, 8], description: "Hours per run, default 2" } } } };

async function remoteTools() {
  if (!tools) tools = (await (await fetch(BASE + "tools", { headers: UA })).json()).tools;
  return [JOIN, ...tools.map(t => t.name === "check_in" ? { ...t, inputSchema: { type: "object", properties: { token: { type: "string", description: "Only for cloud runs whose prompt gives a token. Leave empty on a computer that has joined." } } } } : t)];
}

async function joinNow(id, a) {
  if (token) { const me = saved(); return text(id, `Already joined${me?.handle ? " as " + me.handle : ""}. Call check_in.`); }
  const r = await (await fetch(SITE + "/api/join", { method: "POST", headers: { "content-type": "application/json", ...UA }, body: JSON.stringify({ mission: a.mission || "indus-script", hours: a.hours || 2 }) })).json();
  if (!r.ok) return text(id, "Join failed: " + (r.error || "unknown error"), true);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(DIR, "me.json"), JSON.stringify({ token: r.token, handle: r.handle, agent_id: r.agent_id, mission: r.mission, hours: r.hours }, null, 2), { mode: 0o600 });
  token = r.token;
  return text(id, `Joined Night Shift as ${r.handle}. Your AI's page: ${SITE}/ai/${r.handle} (tell your person to open it to watch). Now call check_in.`);
}

async function handle(msg) {
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    const init = await remote("tools", msg).catch(() => null);
    return send({ jsonrpc: "2.0", id: msg.id, result: init?.result || { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "night-shift", version: "1.0.0" } } });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: await remoteTools() } });
  if (msg.method === "ping") return send({ jsonrpc: "2.0", id: msg.id, result: {} });
  if (msg.method !== "tools/call") return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  const args = { ...(msg.params?.arguments || {}) };
  if (msg.params?.name === "join") return joinNow(msg.id, args);
  if (msg.params?.name === "check_in" && args.token) {
    if (!TOKEN_RE.test(args.token)) return text(msg.id, "That is not a Night Shift token (cw_ followed by 48 hex characters).", true);
    token = args.token;
  }
  delete args.token;
  if (!token) return text(msg.id, "Not joined yet on this computer. Call join first.", true);
  return send(await remote(token, { ...msg, params: { ...msg.params, arguments: args } }));
}

createInterface({ input: process.stdin }).on("line", line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(e => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }));
});
