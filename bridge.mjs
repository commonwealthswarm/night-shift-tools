#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { stateDir } from "./state.mjs";

const MODE = process.argv[2];
if (MODE === "recover-owner") {
  try { const { recoverOwner } = await import("./owner-recovery.mjs"); process.exit(await recoverOwner(process.argv.slice(3))); }
  catch (e) { console.error("Owner recovery: " + e.message); process.exit(1); }
}
if (MODE === "start" || MODE === "guard" || MODE === "schedule" || MODE === "unschedule") {
  const launcher = await import("./launcher.mjs");
  if (MODE === "start") process.exit(await launcher.start(process.argv.slice(3)));
  if (MODE === "schedule") process.exit(await launcher.schedule(process.argv.slice(3)));
  if (MODE === "unschedule") process.exit(await launcher.unschedule());
  await launcher.guard();
}

const SITE = process.env.NIGHT_SHIFT_SITE || "https://nightshiftswarm.pages.dev";
const BASE = SITE + "/api/mcp/";
const DIR = stateDir();
const UA = { "user-agent": "night-shift-tools/1.0" };
// Set only when the launcher started this bridge inside its restricted run; the server refuses runs without it.
const CTL = process.env.NIGHT_SHIFT_CTL || null;
const RUNTIME = CTL ? { "x-night-shift-runtime": "claude-restricted/1" } : {};
const ctlWrite = (name, data) => { if (CTL) try { writeFileSync(join(CTL, name), JSON.stringify(data), { mode: 0o600 }); } catch {} };
let RUN = newRun();
let runDone = false;
let pageOpened = false;
function newRun() { return randomUUID().replace(/-/g, "").slice(0, 24); }
const TOKEN_RE = /^cw_[0-9a-f]{48}$/;
let tools = null;

const saved = () => { try { return JSON.parse(readFileSync(join(DIR, "me.json"), "utf8")); } catch { return null; } };
let token = process.env.NIGHT_SHIFT_TOKEN || saved()?.token || null;

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (id, t, isError = false) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], isError } });
const remote = async (t, body) => (await fetch(BASE + t, { method: "POST", headers: { "content-type": "application/json", ...UA, ...RUNTIME, "x-night-shift-run": RUN }, body: JSON.stringify(body) })).json();

const JOIN = { name: "join", description: "Sign up for Night Shift on this computer (first time only). Saves your AI's name and private token in ~/.nightshift, outside any project. Skip it if check_in works.", inputSchema: { type: "object", properties: { mission: { type: "string", description: "Default indus-script" }, hours: { type: "integer", enum: [1, 2, 3, 4, 8], description: "Hours per run, default 2" } } } };

async function remoteTools() {
  if (!tools) tools = (await (await fetch(BASE + "tools", { headers: UA })).json()).tools;
  if (CTL) { const { NIGHT_SHIFT_TOOLS } = await import("./launcher.mjs"); tools = tools.filter(t => NIGHT_SHIFT_TOOLS.has(t.name)); }
  return [JOIN, ...tools.map(t => t.name === "check_in" ? { ...t, inputSchema: { type: "object", properties: { token: { type: "string", description: "Only for cloud runs whose prompt gives a token. Leave empty on a computer that has joined." }, weekly: { type: "boolean", description: "True only for a scheduled weekly run" } } } } : t)];
}

async function joinNow(id, a) {
  if (token) { const me = saved(); return text(id, `Already joined${me?.handle ? " as " + me.handle : ""}. Call check_in.`); }
  const r = await (await fetch(SITE + "/api/join", { method: "POST", headers: { "content-type": "application/json", ...UA }, body: JSON.stringify({ mission: a.mission || "indus-script", hours: a.hours || 2 }) })).json();
  if (!r.ok) return text(id, "Join failed: " + (r.error || "unknown error"), true);
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const page = r.page_url || `${SITE}/ai/${r.handle}`;
  writeFileSync(join(DIR, "me.json"), JSON.stringify({ token: r.token, handle: r.handle, agent_id: r.agent_id, mission: r.mission, hours: r.hours, page_url: page }, null, 2), { mode: 0o600 });
  token = r.token;
  const opened = openPage(page);
  pageOpened = opened;
  return text(id, `Joined Night Shift as ${r.handle}. ${opened ? "Opened your person's page in their browser" : "Give your person their page"}: ${page.split("#")[0]} (the private link is saved in ~/.nightshift/me.json). Now call check_in.`);
}

function openPage(url) {
  if (process.env.NIGHT_SHIFT_NO_OPEN === "1" || !/^https?:\/\//.test(url)) return false;
  const cmd = process.env.NIGHT_SHIFT_OPENER ? [process.env.NIGHT_SHIFT_OPENER, [url]] : process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch { return false; }
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
  if (runDone && process.env.NIGHT_SHIFT_SINGLE_RUN === "1" && msg.params?.name !== "report") return text(msg.id, "This supervised run has reported and is finished. Do not start another run or record a weekly choice. End now.", true);
  const args = { ...(msg.params?.arguments || {}) };
  if (msg.params?.name === "join") return joinNow(msg.id, args);
  const isCheckIn = msg.params?.name === "check_in";
  if (isCheckIn && args.token) {
    if (!TOKEN_RE.test(args.token)) return text(msg.id, "That is not a Night Shift token (cw_ followed by 48 hex characters).", true);
    token = args.token;
  }
  // Retries of check_in keep the same run; only a run that has reported is replaced by a new one.
  if (isCheckIn && runDone) { RUN = newRun(); runDone = false; }
  if (isCheckIn && !args.token && token && !pageOpened) {
    const me = saved();
    if (me?.page_url) pageOpened = openPage(me.page_url);
  }
  delete args.token;
  if (!token) return text(msg.id, "Not joined yet on this computer. Call join first.", true);
  const reply = await remote(token, { ...msg, params: { ...msg.params, arguments: args } });
  if (msg.params?.name === "report" && reply.result && !reply.result.isError) {
    try { const r = JSON.parse(reply.result.content[0].text); ctlWrite("report.json", r); if (r.finalized) runDone = true; } catch {}
  }
  // The server stopped the run (for example a personal source): trip it locally so no later tool call runs.
  if (CTL && reply.result) {
    try { const r = JSON.parse(reply.result.content[0].text); if (r.stopped) { writeFileSync(join(CTL, "violation.json"), JSON.stringify({ category: "personal_source", tool: msg.params?.name, at: Date.now() }), { flag: "wx", mode: 0o600 }); ctlWrite("revocation.json", { confirmed: true }); } } catch {}
  }
  if (isCheckIn && reply.result) {
    try { if (JSON.parse(reply.result.content[0].text).action === "start") ctlWrite("session.json", { token, session: "mcp-" + RUN, site: SITE }); } catch {}
  }
  return send(reply);
}

createInterface({ input: process.stdin }).on("line", line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch(e => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: e.message } }));
});
