import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, realpathSync, lstatSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep, isAbsolute, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import { claudeVersion, managedSettings, SUBSCRIPTION_USAGE_NOTICE, codexState, USAGE_LIMIT } from "./providers.mjs";
import { fileURLToPath } from "node:url";
import { stateDir } from "./state.mjs";
import { SUPERVISED_TOOL_CALLS, reserveToolCall, admittedToolCalls, streamCounters } from "./budget.mjs";

export const RUNTIME = "claude-restricted/1";
export const RUN_PREFIX = "night-shift-run-";
export const CTL_PREFIX = "night-shift-ctl-";
const SITE = process.env.NIGHT_SHIFT_SITE || "https://nightshiftswarm.pages.dev";
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "Glob", "Grep"]);
const SERVER = "night-shift";
// The exact Night Shift tools a run may call. Any other name, even under the night-shift prefix, ends the run.
export const NIGHT_SHIFT_TOOLS = new Set(["join", "check_in", "next_task", "read_task", "feed", "post_note", "heartbeat", "checkpoint", "submit", "split", "read_files", "query_data", "checks", "review", "narrate", "await_choice", "record_choice", "request_source", "status", "report", "list_sources", "read_source", "submit_readings", "readings_to_check", "check_readings",
  // Indus research tools: server-side only. Images arrive as MCP image content from view_source_image; the run still
  // can't open files outside its folder, fetch URLs or run commands.
  "research_requirements", "list_source_images", "view_source_image", "list_claim_packets", "create_claim_packet", "add_prediction", "preregister_packet",
  "run_prediction", "reproduce_prediction", "report_counterexample", "review_counterexample", "review_claim_packet", "submit_comparison", "comparisons_to_review", "review_comparison"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);
// Settings and tool config a session could pick up from its folder. Nothing launcher-owned lives in the folder.
const PROTECTED = /(^|\/)(\.claude|\.mcp\.json|\.night-shift[^/]*|CLAUDE\.md|CLAUDE\.local\.md|\.git)(\/|$)/i;
const REASONS = {
  outside_folder: "It tried to read or change a file outside its own run folder.",
  tool_not_allowed: "It tried to use a tool that Night Shift runs don't allow.",
  protected_path: "It tried to change settings or tool files that Night Shift runs don't allow.",
  personal_source: "It asked for a personal source (email, cloud files, accounts or this computer's network), which is never allowed.",
  tool_budget: "It reached the supervised run's tool-call limit. Further tool calls are refused.",
};

// Only what Claude Code needs to start and sign in to the person's own account. Cloud keys, tokens for other
// services, proxies, NODE_OPTIONS and every other variable stay behind.
// No API keys, bearer tokens, OAuth token variables, profiles, model redirects or cloud-provider switches: the run
// signs in only with the person's own saved Claude subscription login, and the preflight below checks that.
const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "TZ", "TMPDIR", "CLAUDE_CONFIG_DIR", "NIGHT_SHIFT_SITE", "NIGHT_SHIFT_NO_OPEN", "NIGHT_SHIFT_STATE_DIR"];
// Test mode only, against a fake model on this machine: a fake key and a loopback address (see testMode).
const PASS_TEST_ENV = ["NIGHT_SHIFT_AUDIT", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "DISABLE_TELEMETRY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER"];

export function testMode(parent) {
  if (parent.NIGHT_SHIFT_TEST_MODEL !== "1") return null;
  const ok = /^http:\/\/127\.0\.0\.1:\d+$/.test(parent.ANTHROPIC_BASE_URL || "") && /^sk-ant-test-[a-z0-9-]+$/.test(parent.ANTHROPIC_API_KEY || "");
  return ok ? "local" : "invalid";
}

export const SUBSCRIPTION_METHODS = new Set(["claude.ai"]);
export const ELIGIBLE_PLANS = new Set(["pro", "max", "team", "enterprise"]);
// Asks Claude Code which credential this exact environment would use. Only a saved Claude subscription login
// (Pro, Max, Team or Enterprise) on Anthropic itself passes; API keys, key helpers, Console and cloud providers don't.
// It runs under the same restricted policy and settings as the run itself, so it sees only what the run would.
export async function preflight(bin, env, cwd, settings = "{}") {
  const out = await new Promise(r => {
    const p = spawn(bin, ["--restricted", "--settings", settings, "auth", "status", "--json"], { env, cwd, stdio: ["ignore", "pipe", "ignore"] });
    let buf = ""; p.stdout.on("data", d => buf += d);
    const t = setTimeout(() => p.kill("SIGKILL"), 20_000);
    p.on("exit", code => { clearTimeout(t); r({ code, buf }); }); p.on("error", () => { clearTimeout(t); r({ code: 127, buf: "" }); });
  });
  if (out.code === 127) return { ok: false, why: "missing", say: "Claude Code wasn't found. Install it from claude.com/code, sign in with your Claude subscription, then run this line again." };
  let st; try { st = JSON.parse(out.buf); } catch { return { ok: false, why: "unreadable", say: "Night Shift couldn't read Claude Code's sign-in status, so it didn't start." }; }
  if (!st.loggedIn || st.authMethod === "none") return { ok: false, why: "signed_out", say: "Claude Code isn't signed in. Run claude, sign in with your Claude subscription, then run this line again." };
  if (!SUBSCRIPTION_METHODS.has(st.authMethod) || st.apiProvider !== "firstParty") {
    const what = st.authMethod === "api_key" || st.authMethod === "api_key_helper" ? `an API key${st.apiKeySource ? ` (${String(st.apiKeySource).slice(0, 60)})` : ""}, which is billed per use` : st.authMethod === "third_party" || st.apiProvider !== "firstParty" ? "a cloud provider account" : "a sign-in Night Shift can't confirm is a subscription";
    return { ok: false, why: "not_subscription", method: st.authMethod || null, provider: st.apiProvider || null, say: `Claude Code in Terminal is signed in with ${what}. Night Shift runs only on a Claude subscription and never falls back to paid API use, so it didn't start. Being signed in to the Claude desktop app doesn't sign Terminal in. To switch Terminal to your subscription, run this yourself: claude auth login --claudeai (Night Shift never signs in for you), then run this line again. Your subscription's extra-usage settings remain your choice; enabled extra usage may incur additional charges.` };
  }
  const plan = String(st.subscriptionType || "").toLowerCase();
  if (!ELIGIBLE_PLANS.has(plan)) return { ok: false, why: "plan", plan: plan || null, say: `Night Shift couldn't confirm a Claude Pro, Max, Team or Enterprise plan on this sign-in${plan ? ` (it reports "${plan}")` : ""}, so it didn't start. It never falls back to paid API use.` };
  return { ok: true, plan };
}

export function runEnv(parent, extra) {
  const keep = testMode(parent) === "local" ? [...PASS_ENV, ...PASS_TEST_ENV] : PASS_ENV;
  const env = {};
  for (const k of keep) if (parent[k] !== undefined) env[k] = parent[k];
  for (const k of Object.keys(parent)) if (/^LC_[A-Z]+$/.test(k)) env[k] = parent[k];
  return { ...env, ...extra };
}

export const runSettings = self => JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `"${process.execPath}" "${self}" guard` }] }] } });

export function claudeArgs(self, runDir, prompt, { supervised = false } = {}) {
  const node = process.execPath;
  const mcp = { mcpServers: { [SERVER]: { command: node, args: [self] } } };
  return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--restricted", "--tools", [...FILE_TOOLS].join(","), "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--settings", runSettings(self), "--permission-mode", "acceptEdits", "--permission-prompts", "none", "--allowedTools", "mcp__" + SERVER,
    ...(supervised ? ["--model", "haiku", "--effort", "low", "--max-turns", "16", "--no-chrome"] : [])];
}

// Resolves through symlinks: the nearest existing ancestor is made real, so a link inside the folder can't point out of it.
function realTarget(root, p) {
  let cur = resolve(root, String(p).replace(/^~(?=$|\/)/, homedir())), rest = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest); } catch {}
    const up = dirname(cur);
    if (up === cur) return join(cur, ...rest);
    rest.unshift(basename(cur)); cur = up;
  }
}
const inside = (root, p) => { const r = realTarget(root, p); return r === root || r.startsWith(root + sep); };

// Decides one tool call. Returns null to allow, or a violation category.
export function judge(event, runDir) {
  const name = event.tool_name || "";
  if (name.startsWith(`mcp__${SERVER}__`)) return NIGHT_SHIFT_TOOLS.has(name.slice(SERVER.length + 7)) ? null : "tool_not_allowed";
  if (!FILE_TOOLS.has(name)) return "tool_not_allowed";
  const i = event.tool_input || {};
  for (const key of ["file_path", "path", "notebook_path"]) if (i[key] != null && !inside(runDir, i[key])) return "outside_folder";
  if (WRITE_TOOLS.has(name)) for (const key of ["file_path", "notebook_path"]) if (i[key] != null && PROTECTED.test(realTarget(runDir, i[key]).slice(runDir.length))) return "protected_path";
  if (name === "Glob" && i.pattern && (isAbsolute(i.pattern) || /^~|(^|\/)\.\.(\/|$)/.test(i.pattern))) return "outside_folder";
  if (name === "Grep" && i.glob && /^~|^\/|(^|\/)\.\.(\/|$)/.test(i.glob)) return "outside_folder";
  return null;
}

// Every tool use the session has attempted, including ones whose hook never fires (disabled or unknown tools).
export function scanTranscript(file, runDir) {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    let m; try { m = JSON.parse(line); } catch { continue; }
    const content = m?.type === "assistant" ? m.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const c of content) if (c.type === "tool_use") { const v = judge({ tool_name: c.name, tool_input: c.input }, runDir); if (v) return v; }
  }
  return null;
}

// Once tripped, the run stays tripped: every later tool call is refused, allowed ones included.
export async function trip(ctl, category, tool) {
  let first = false;
  try { writeFileSync(join(ctl, "violation.json"), JSON.stringify({ category, tool: tool || null, at: Date.now() }), { flag: "wx", mode: 0o600 }); first = true; } catch {}
  if (first) writeFileSync(join(ctl, "revocation.json"), JSON.stringify(await reportViolation(ctl, category)), { mode: 0o600 });
  return JSON.parse(readFileSync(join(ctl, "violation.json"), "utf8")).category;
}

export async function guard() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const ctl = process.env.NIGHT_SHIFT_CTL, runDir = process.env.NIGHT_SHIFT_RUN_DIR;
  let event = {};
  try { event = JSON.parse(raw); } catch {}
  let category = "tool_not_allowed";
  const audit = decision => { if (process.env.NIGHT_SHIFT_AUDIT) try { writeFileSync(process.env.NIGHT_SHIFT_AUDIT, JSON.stringify({ tool: event.tool_name, decision }) + "\n", { flag: "a" }); } catch {} };
  if (ctl && runDir) {
    const root = realpathSync(runDir);
    category = existsSync(join(ctl, "violation.json")) ? "tripped" : judge(event, root) || scanTranscript(join(ctl, "attempts.jsonl"), root) || (event.transcript_path ? scanTranscript(event.transcript_path, root) : null);
    if (!category && !reserveToolCall(ctl)) category = "tool_budget";
    if (!category) { audit("allow"); return process.exit(0); }
    category = await trip(ctl, category === "tripped" ? "tool_not_allowed" : category, event.tool_name);
  }
  audit("deny:" + category);
  const reason = REASONS[category] || REASONS.tool_not_allowed;
  process.stdout.write(JSON.stringify({ continue: false, stopReason: "Night Shift stopped this run: " + reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Night Shift: " + reason + " This run is over." } }));
  process.exit(0);
}

// Revocation counts only when the server says so; anything else is reported as unconfirmed.
export const reportViolation = (ctl, category) => closeOnServer(ctl, category === "tool_budget" ? "/api/run/end" : "/api/run/violation", category);

export async function closeOnServer(ctl, route, category) {
  let s;
  try { s = JSON.parse(readFileSync(join(ctl, "session.json"), "utf8")); } catch { return { confirmed: false, why: "no_run" }; }
  try {
    const r = await fetch((s.site || SITE) + route, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/json", authorization: "Bearer " + s.token, "x-night-shift-session": s.session, "x-night-shift-runtime": RUNTIME }, body: JSON.stringify({ category }) });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.stopped === true ? { confirmed: true } : { confirmed: false, why: "refused", status: r.status };
  } catch { return { confirmed: false, why: "unreachable" }; }
}

export function endMessage(why, ended) {
  const what = why === "time" ? "The run reached its time limit and was ended." : why === "cancel" ? "The run was cancelled." : why === "usage_limit" ? "The provider rejected further usage at its usage limit. Night Shift doesn't retry or switch accounts or API keys." : "The run ended without its report.";
  if (ended.confirmed) return `Night Shift: ${what} The server confirmed the run's access is closed.`;
  if (ended.why === "no_run") return `Night Shift: ${what} It hadn't started on the server, so no access had been given.`;
  return `Night Shift: ${what} Its server couldn't confirm that the run's access is closed; it closes by itself at the run's time limit. The details are saved in ~/.nightshift/reports.`;
}

export function stopMessage(violation, revocation) {
  const reason = REASONS[violation.category] || REASONS.tool_not_allowed;
  if (revocation?.confirmed) return `Night Shift stopped this run: ${reason} The server confirmed the run's access is revoked. Your page shows the report.`;
  if (revocation?.why === "no_run") return `Night Shift stopped this run before it started: ${reason} No access had been given yet.`;
  return `Night Shift stopped this run here: ${reason} Its server couldn't confirm that the run's access was revoked, so the reason is saved on this computer in ~/.nightshift/reports.`;
}

// Deletes only a folder this launcher created: a direct child of the temp dir with our prefix, never a link, and the
// same directory (device and inode) recorded when it was made. Nothing inside the folder is trusted for this.
export function identity(dir) { const st = lstatSync(dir); return { dev: st.dev, ino: st.ino }; }
export function teardown(dir, base, prefix, id) {
  const name = dir.slice(base.length + 1);
  if (!dir.startsWith(base + sep) || name.includes(sep) || !name.startsWith(prefix) || !id) return false;
  let st;
  try { st = lstatSync(dir); } catch { return false; }
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== id.dev || st.ino !== id.ino) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// The launcher opens the person's page itself (it runs in their own Terminal session), once per run.
export function openPage(url, env = process.env) {
  if (env.NIGHT_SHIFT_NO_OPEN === "1" || !/^https?:\/\//.test(url || "")) return false;
  const cmd = env.NIGHT_SHIFT_OPENER ? [env.NIGHT_SHIFT_OPENER, [url]] : process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { const p = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }); p.on("error", () => {}); p.unref(); return true; } catch { return false; }
}

// A closed Terminal can make writes fail; cleanup must go on regardless.
function say(text) { try { process.stdout.write(text + "\n"); } catch {} }

const readMe = () => { try { return JSON.parse(readFileSync(join(stateDir(), "me.json"), "utf8")); } catch { return null; } };

// Asks the server whether a weekly run may start now: Join weekly chosen, the swarm live, not already run this week.
export async function weeklyReady(me) {
  if (!me?.token) return { ready: false, reason: "This computer hasn't joined Night Shift yet." };
  try {
    const r = await fetch(SITE + "/api/weekly/ready", { headers: { authorization: "Bearer " + me.token }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    return r.ok && j.ok ? j : { ready: false, reason: j.error || "The server didn't answer." };
  } catch { return { ready: false, reason: "The Night Shift server couldn't be reached." }; }
}

export async function checks(ai, bin, env, settings) {
  if (ai === "codex") return codexState(bin, env, tmpdir());
  for (const step of [() => claudeVersion(bin, env, tmpdir()), () => managedSettings(), () => preflight(bin, env, tmpdir(), settings)]) {
    const r = await step();
    if (!r.ok) return r;
  }
  return { ok: true, say: SUBSCRIPTION_USAGE_NOTICE };
}

export async function start(argv) {
  const self = fileURLToPath(new URL("./bridge.mjs", import.meta.url));
  const supervised = argv.includes("--supervised");
  try { stateDir(); } catch (e) { say("Night Shift: " + e.message); return 2; }
  if (supervised && (!process.env.NIGHT_SHIFT_STATE_DIR || !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NIGHT_SHIFT_SITE || "") || argv.includes("--weekly"))) {
    say("Night Shift: a supervised test needs a separate state directory and loopback API, and cannot be weekly."); return 2;
  }
  const ai = argv.includes("--ai") ? argv[argv.indexOf("--ai") + 1] : "claude";
  if (!["claude", "codex"].includes(ai)) { say(`Night Shift: "${ai}" isn't a supported AI. Use claude or codex.`); return 2; }
  const mode = testMode(process.env), bin = ai === "codex" ? process.env.NIGHT_SHIFT_CODEX || "codex" : process.env.NIGHT_SHIFT_CLAUDE || "claude";
  if (argv.includes("--weekly")) {
    const w = await weeklyReady(readMe());
    if (!w.ready) { say("Night Shift weekly run: not starting. " + (w.reason || "")); return 0; }
  }
  if (mode === "invalid") { say("Night Shift: test mode needs a fake key and a model address on 127.0.0.1. Nothing was started."); return 4; }
  if (mode === "local" && ai === "claude") say("Night Shift TEST MODE: a fake model on this computer, not a real run.");
  else {
    const check = await checks(ai, bin, runEnv(process.env, {}), runSettings(self));
    if (!check.ok) { say("Night Shift: " + check.say); return ai === "codex" ? 5 : 4; }
    say(check.say);
  }
  const base = realpathSync(process.env.NIGHT_SHIFT_TMP || tmpdir());
  const runDir = mkdtempSync(join(base, RUN_PREFIX)), ctl = mkdtempSync(join(base, CTL_PREFIX));
  const runId = identity(runDir), ctlId = identity(ctl);
  let cleaned = false;
  try {
  if (supervised) { const budget = join(ctl, "tool-budget"); mkdirSync(budget, { mode: 0o700 }); writeFileSync(join(budget, "limit.json"), JSON.stringify({ max_tool_calls: SUPERVISED_TOOL_CALLS }), { mode: 0o600 }); }
  const me = readMe();
  const workMin = me ? (me.hours || 2) * 60 : 15;
  const requestedLimit = Number(process.env.NIGHT_SHIFT_LIMIT_SECONDS) * 1000;
  const limitMs = supervised ? Math.min(requestedLimit > 0 ? requestedLimit : 120_000, 120_000) : requestedLimit || (workMin + 5) * 60_000;
  const weekly = argv.includes("--weekly");
  const h = Number(argv[argv.indexOf("--hours") + 1]);
  const hours = argv.includes("--hours") && [1, 2, 3, 4, 8].includes(h) ? h : 2;
  const prompt = (weekly ? "Start my weekly Night Shift run: call check_in with weekly true." : "Start my Night Shift run.") + ` If check_in says I haven't joined, call join with mission indus-script and hours ${hours} first.` + (supervised ? ` This is one supervised local test, limited to 16 tool-use cycles, ${SUPERVISED_TOOL_CALLS} tool calls and 120 seconds. Complete only the single small assigned task using the aggregate corpus queries requested by its spec. Narrate briefly, save the findings in a lab note and submission summary, then call report immediately and end. Do not claim another task, start a second run, request external sources, or record a weekly choice. No person is answering questions inside this CLI session.` : "");
  say(`Night Shift: starting in a new empty folder. Your AI can use only the Night Shift tools and that folder. ${supervised ? `Supervised local test: at most ${limitMs / 1000} seconds, then up to 3 seconds for forced termination. The CLI limits tool-use cycles to 16; a separate guard admits at most ${SUPERVISED_TOOL_CALLS} tool calls. The CLI's reported num_turns counts differently. These are not a dollar cap.` : `${me ? `Up to ${workMin / 60} hour${workMin === 60 ? "" : "s"} of work` : "About 15 minutes of work for a first run"}, plus up to 5 minutes to finish its report; it is ended after that.`}`);
  const env = runEnv(process.env, { NIGHT_SHIFT_CTL: ctl, NIGHT_SHIFT_RUN_DIR: runDir, ...(supervised ? {
    NIGHT_SHIFT_SINGLE_RUN: "1", NIGHT_SHIFT_NO_OPEN: "1", CLAUDE_CODE_MAX_RETRIES: "0",
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0",
  } : {}) });
  // A confirmed check-in is the page's reason to watch. Opening before it exists would require idle discovery polling.
  let pageShown = false;
  const showPage = () => {
    if (!existsSync(join(ctl, "session.json"))) return;
    // Computers that joined with an older version saved only the AI's name, so open its public page instead.
    const me = readMe(), url = me?.page_url || (/^[a-z]+-[a-z]+-\d{3}$/.test(me?.handle || "") ? `${SITE}/ai/${me.handle}` : null);
    if (pageShown || !url) return;
    pageShown = true;
    say("Watch your AI live: " + url.split("#")[0]);
    if (!supervised) openPage(url);
  };
  showPage();
  const pageWatch = setInterval(showPage, 1000); pageWatch.unref();
  env.NIGHT_SHIFT_NO_OPEN = "1";
  const child = spawn(bin, claudeArgs(self, runDir, prompt, { supervised }), { cwd: runDir, env, stdio: ["ignore", "pipe", "inherit"] });
  let why = null, finalText = null, providerResult = null;
  const counters = streamCounters();
  const stop = reason => { if (!why) { why = reason; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); } };
  const root = realpathSync(runDir);
  // The stream shows every tool use the model asks for, so a disabled or unknown tool ends the run even though no hook runs for it.
  createInterface({ input: child.stdout }).on("line", async line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (supervised) counters.observe(m);
    if (m.type === "result") {
      finalText = m.result || null;
      if (supervised) providerResult = { subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, duration_ms: m.duration_ms, duration_api_ms: m.duration_api_ms, usage: m.usage, model_usage: m.modelUsage, estimated_list_price_usd: m.total_cost_usd, estimate_is_actual_subscription_charge: false };
      if (m.is_error && USAGE_LIMIT.test(String(m.result || "") + " " + String(m.subtype || ""))) why ||= "usage_limit";
    }
    if (m.type !== "assistant" || !Array.isArray(m.message?.content)) return;
    // Sessions aren't saved to disk, so this log is the guard's record of every tool use the model asked for.
    if (m.message.content.some(c => c.type === "tool_use")) writeFileSync(join(ctl, "attempts.jsonl"), JSON.stringify({ type: "assistant", message: { content: m.message.content.filter(c => c.type === "tool_use") } }) + "\n", { flag: "a", mode: 0o600 });
    for (const c of m.message.content) {
      if (c.type !== "tool_use") continue;
      const v = judge({ tool_name: c.name, tool_input: c.input }, root);
      if (v) { stop("violation"); await trip(ctl, v, c.name); return; }
      if (c.name === `mcp__${SERVER}__narrate` && c.input?.text) say("· " + String(c.input.text).slice(0, 140));
    }
  });
  const timer = setTimeout(() => stop("time"), limitMs);
  // Ctrl-C, a closed Terminal or a kill still end the session and clean up below.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map(sig => { const f = () => stop("cancel"); process.on(sig, f); return [sig, f]; });
  const watch = setInterval(() => { if (existsSync(join(ctl, "violation.json"))) stop("violation"); }, 250);
  const code = await new Promise(r => { child.on("exit", c => r(c)); child.on("error", () => r(127)); });
  showPage();
  clearInterval(pageWatch);
  for (const [sig, f] of signals) process.off(sig, f);
  await new Promise(r => setTimeout(r, 200));
  if (finalText && !existsSync(join(ctl, "violation.json"))) say("\n" + finalText);
  clearTimeout(timer); clearInterval(watch);
  const violation = existsSync(join(ctl, "violation.json")) ? JSON.parse(readFileSync(join(ctl, "violation.json"), "utf8")) : null;
  let revocation = null;
  for (let i = 0; violation && i < 40 && !revocation; i++) { try { revocation = JSON.parse(readFileSync(join(ctl, "revocation.json"), "utf8")); } catch { await new Promise(r => setTimeout(r, 250)); } }
  // Any exit without a finalized report closes the run on the server too: cancel, time limit, an AI that stops
  // early or a crash. It is only claimed closed when the server confirms.
  const finalized = (() => { try { return JSON.parse(readFileSync(join(ctl, "report.json"), "utf8")).finalized === true; } catch { return false; } })();
  const endCategory = why === "time" ? "time_limit" : why === "cancel" ? "cancelled" : why === "usage_limit" ? "usage_limit" : "no_report";
  const ended = !violation && !finalized ? await closeOnServer(ctl, "/api/run/end", endCategory) : null;
  const session = (() => { try { return JSON.parse(readFileSync(join(ctl, "session.json"), "utf8")).session; } catch { return null; } })();
  const keep = join(stateDir(), "reports"), stamp = Date.now();
  if (supervised) {
    mkdirSync(keep, { recursive: true, mode: 0o700 });
    writeFileSync(join(keep, `${stamp}-metrics.json`), JSON.stringify({ ...counters.snapshot(), tool_calls_admitted: admittedToolCalls(ctl), max_tool_calls: SUPERVISED_TOOL_CALLS, native_max_tool_use_turns: 16, cli_num_turns: providerResult?.num_turns ?? null }, null, 2), { mode: 0o600 });
    if (providerResult) writeFileSync(join(keep, `${stamp}-provider.json`), JSON.stringify(providerResult, null, 2), { mode: 0o600 });
  }
  if (ended) { mkdirSync(keep, { recursive: true, mode: 0o700 }); writeFileSync(join(keep, `${stamp}-ended.json`), JSON.stringify({ ended: endCategory, at: Date.now(), session, server_confirmed: !!ended.confirmed, detail: ended.why || null }, null, 2), { mode: 0o600 }); }
  if (existsSync(join(ctl, "report.json")) || violation) mkdirSync(keep, { recursive: true, mode: 0o700 });
  if (existsSync(join(ctl, "report.json"))) copyFileSync(join(ctl, "report.json"), join(keep, `${stamp}.json`));
  if (violation) writeFileSync(join(keep, `${stamp}-stopped.json`), JSON.stringify({ stopped: true, reason: REASONS[violation.category] || REASONS.tool_not_allowed, category: violation.category, at: violation.at, revocation_confirmed: !!revocation?.confirmed, revocation_detail: revocation?.why || null, session }, null, 2), { mode: 0o600 });
  cleaned = teardown(runDir, base, RUN_PREFIX, runId) && teardown(ctl, base, CTL_PREFIX, ctlId);
  if (violation) say("\n" + stopMessage(violation, revocation));
  else if (ended) say("\n" + endMessage(why, ended));
  else if (code === 127) say("\nNight Shift: Claude Code wasn't found. Install it from claude.com/code, then run this line again.");
  say(cleaned ? "The run folder was deleted." : "The run folder was left in place: " + runDir);
  if (me?.page_url) say("Your page: " + me.page_url.split("#")[0]);
  return violation ? 3 : why === "cancel" ? 130 : code ?? 1;
  } finally {
    if (!cleaned) { teardown(runDir, base, RUN_PREFIX, runId); teardown(ctl, base, CTL_PREFIX, ctlId); }
  }
}

// A scheduler starts with almost no environment (launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin), so the schedule
// names the node, npx and Claude Code found now, by full path, and sets its own PATH from their folders.
export function scheduleSpec(tool, env, which = whichSync) {
  const node = process.execPath, npx = join(dirname(node), "npx"), claude = which("claude", env.PATH || "");
  if (!existsSync(npx)) return { ok: false, say: `npx wasn't found next to node (${node}), so no schedule was written.` };
  if (!claude) return { ok: false, say: "Claude Code wasn't found on your PATH, so no schedule was written." };
  const path = [...new Set([dirname(node), dirname(claude), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  return { ok: true, argv: [npx, "-y", tool, "start", "--weekly"], env: { PATH: path, NIGHT_SHIFT_CLAUDE: claude } };
}
export function whichSync(name, pathVar) {
  for (const d of pathVar.split(":").filter(Boolean)) { const f = join(d, name); try { if (existsSync(f)) return realpathSync(f); } catch {} }
  return null;
}
const xml = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function plistFor(plan, logFile) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nightshift.weekly</string>
  <key>ProgramArguments</key><array>${plan.argv.map(a => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(plan.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}
const sh = v => "'" + String(v).replace(/'/g, "'\\''") + "'";
export function cronFor(plan, logFile) {
  return `*/5 * * * * env ${Object.entries(plan.env).map(([k, v]) => `${k}=${sh(v)}`).join(" ")} ${plan.argv.map(sh).join(" ")} >> ${sh(logFile)} 2>&1\n`;
}

// Writes a weekly schedule for the person to review and install themselves; Night Shift never installs it.
// It checks every 5 minutes, and only the check inside the live Sunday swarm (one per week) starts a run.
export async function schedule(argv) {
  const tool = argv.includes("--tool") ? argv[argv.indexOf("--tool") + 1] : null;
  const ai = argv.includes("--ai") ? argv[argv.indexOf("--ai") + 1] : "claude";
  if (ai !== "claude") { say("Night Shift: weekly schedules are only for Claude Code. " + (ai === "codex" ? "Night Shift doesn't run on Codex yet." : "")); return 5; }
  if (!tool || !/^https:\/\/codeload\.github\.com\/commonwealthswarm\/night-shift-tools\/tar\.gz\/[0-9a-f]{40}$/.test(tool)) { say("Night Shift: copy the schedule line from your page; it names the exact tools version."); return 2; }
  const w = await weeklyReady(readMe());
  if (w.choice !== "weekly") { say("Night Shift: your page doesn't show Join weekly, so no schedule was written."); return 3; }
  const plan = scheduleSpec(tool, process.env);
  if (!plan.ok) { say("Night Shift: " + plan.say); return 4; }
  const dir = join(stateDir(), "schedule");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let file, how;
  if (process.platform === "darwin") {
    file = join(dir, "com.nightshift.weekly.plist");
    writeFileSync(file, plistFor(plan, join(dir, "weekly.log")), { mode: 0o600 });
    how = `To install it yourself: cp "${file}" ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.nightshift.weekly.plist`;
  } else {
    file = join(dir, "crontab.txt");
    writeFileSync(file, cronFor(plan, join(dir, "weekly.log")), { mode: 0o600 });
    how = `To install it yourself, add the lines in ${file} with crontab -e`;
  }
  say(`Night Shift wrote a weekly schedule to ${file}. It is NOT installed: nothing will run until you install it. It checks every 5 minutes and starts one run only during the Sunday 8 PM Pacific swarm, ${w.next_swarm_local || "the same moment worldwide"}. ${how}`);
  return 0;
}
