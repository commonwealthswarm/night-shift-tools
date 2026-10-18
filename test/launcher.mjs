// Privacy boundary tests for the launcher. Disposable fixtures only: every "personal" file, setting, key and
// home folder here is a temp-dir stand-in, and the model is test/mock-model.mjs, so no real account is used.
// The unit part always runs. The end-to-end part runs real Claude Code and needs SITE: a fresh local Night Shift
// API with the boundary on (ALLOW_UNENFORCED_RUNS unset). Use new state each time: joins are limited to 20 per address per hour.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readdirSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { judge, scanTranscript, teardown, identity, runEnv, testMode, preflight, RUN_PREFIX, trip, stopMessage } from "../launcher.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "..", "bridge.mjs");
const SITE = process.env.SITE || null;
let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };
const fixture = () => realpathSync(mkdtempSync(path.join(tmpdir(), "ns-priv-")));

// Paths, links and tools.
{
  const F = fixture(), run = path.join(F, "run"), outside = path.join(F, "personal");
  mkdirSync(run); mkdirSync(outside); writeFileSync(path.join(outside, "secret.txt"), "CANARY");
  symlinkSync(outside, path.join(run, "link"));
  const j = (tool_name, tool_input) => judge({ tool_name, tool_input }, run);
  ok(j("Read", { file_path: path.join(run, "notes.md") }) === null && j("Glob", { pattern: "**/*.md" }) === null && j("Grep", { pattern: "x" }) === null, "files inside the run folder are allowed");
  ok(j("Read", { file_path: path.join(outside, "secret.txt") }) === "outside_folder", "an absolute path outside is refused");
  ok(j("Read", { file_path: path.join(run, "..", "personal", "secret.txt") }) === "outside_folder" && j("Read", { file_path: "../personal/secret.txt" }) === "outside_folder", "a .. escape is refused");
  ok(j("Read", { file_path: "~/secret.txt" }) === "outside_folder", "a ~ path is refused");
  ok(j("Read", { file_path: path.join(run, "link", "secret.txt") }) === "outside_folder" && j("Write", { file_path: path.join(run, "link", "new.txt"), content: "x" }) === "outside_folder", "a symlink inside the folder that points out is refused");
  ok(j("Glob", { pattern: "/Users/**" }) === "outside_folder" && j("Glob", { pattern: "../**" }) === "outside_folder" && j("Grep", { pattern: "x", glob: "~/**" }) === "outside_folder", "search patterns can't reach outside");
  ok(["Bash", "WebFetch", "WebSearch", "Agent", "Skill", "SomethingNew", "mcp__personal__read_mail"].every(t => j(t, {}) === "tool_not_allowed"), "any other tool, known or unknown, is a violation");
  ok(j("mcp__night-shift__check_in", {}) === null && j("mcp__night-shift__query_data", { op: "summary" }) === null, "the Night Shift tools are allowed");
  ok(["mcp__night-shift__read_personal_email", "mcp__night-shift__schedule_created", "mcp__night-shift__", "mcp__night-shift-extra__check_in"].every(t => j(t, {}) === "tool_not_allowed"), "an invented or unlisted tool under the Night Shift name is a violation");
  ok([".night-shift-run", ".claude/settings.json", ".mcp.json", "CLAUDE.md", ".git/config", "sub/.claude/x"].every(p => j("Write", { file_path: path.join(run, p), content: "x" }) === "protected_path") && j("Edit", { file_path: ".mcp.json", old_string: "a", new_string: "b" }) === "protected_path", "writes to settings, tool config or markers inside the folder are refused");
  ok(j("Write", { file_path: path.join(run, "notes", "claude-notes.md"), content: "x" }) === null, "ordinary notes inside the folder are fine");
  const transcript = path.join(F, "t.jsonl");
  writeFileSync(transcript, [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: path.join(run, "a.md") } }] } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } })].join("\n"));
  ok(scanTranscript(transcript, run) === "tool_not_allowed", "an attempt the hook never saw is still found in the session transcript");
}

// Teardown deletes only what the launcher made, judged from outside the folder, and never follows links.
{
  const F = fixture(), keep = path.join(F, "keep");
  mkdirSync(keep); writeFileSync(path.join(keep, "mine.txt"), "x");
  const mk = name => { const d = path.join(F, name); mkdirSync(d); return d; };
  const good = mk(RUN_PREFIX + "good"), goodId = identity(good);
  symlinkSync(keep, path.join(good, "link-to-keep"));
  writeFileSync(path.join(good, ".night-shift-run"), "forged by the AI");
  const other = mk(RUN_PREFIX + "other");
  ok(teardown(other, F, RUN_PREFIX, goodId) === false && existsSync(other), "a different folder with the run prefix is left alone");
  ok(teardown(mk("unrelated"), F, RUN_PREFIX, identity(path.join(F, "unrelated"))) === false, "a folder without the run prefix is left alone");
  const linked = path.join(F, RUN_PREFIX + "link"); symlinkSync(keep, linked);
  ok(teardown(linked, F, RUN_PREFIX, identity(keep)) === false && existsSync(path.join(keep, "mine.txt")), "a run-named link to another folder is left alone");
  ok(teardown(path.join(F, "nested", RUN_PREFIX + "x"), F, RUN_PREFIX, goodId) === false, "only direct children of the temp folder");
  ok(teardown(good, F, RUN_PREFIX, goodId) === true && !existsSync(good) && existsSync(path.join(keep, "mine.txt")), "the run folder is deleted even after the AI writes a fake marker, and a link inside doesn't take its target");
  const swapped = mk(RUN_PREFIX + "swap"), swapId = identity(swapped);
  rmSync(swapped, { recursive: true }); mkdirSync(swapped);
  ok(teardown(swapped, F, RUN_PREFIX, swapId) === false, "a folder replaced at the same path is left alone");
}

// Environment: production passes no credential or redirect variables; test mode needs a fake key on loopback.
{
  const parent = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-real", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", ANTHROPIC_BASE_URL: "http://elsewhere", ANTHROPIC_PROFILE: "work", ANTHROPIC_FEDERATION_RULE_ID: "r", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", AWS_SECRET_ACCESS_KEY: "CANARY", GOOGLE_APPLICATION_CREDENTIALS: "/g", GITHUB_TOKEN: "CANARY", OPENAI_API_KEY: "CANARY", NODE_OPTIONS: "--require x", HTTPS_PROXY: "http://p", LC_ALL: "C", CLAUDE_CONFIG_DIR: "/h/.claude" };
  const env = runEnv(parent, { NIGHT_SHIFT_CTL: "/c" });
  ok(env.PATH && env.HOME && env.LC_ALL && env.CLAUDE_CONFIG_DIR && env.NIGHT_SHIFT_CTL, "the run keeps what Claude Code needs to start with the person's own saved login");
  ok(Object.keys(parent).filter(k => !["PATH", "HOME", "LC_ALL", "CLAUDE_CONFIG_DIR"].includes(k)).every(k => !(k in env)), "API keys, tokens, profiles, model redirects, cloud-provider switches, other keys, proxies and NODE_OPTIONS are all dropped");
  ok(runEnv({ ...parent, NIGHT_SHIFT_TEST_MODEL: "1" }, {}).ANTHROPIC_API_KEY === undefined, "test mode with a real-looking key or a remote model address passes nothing extra");
  ok(testMode({ NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: "http://elsewhere.com", ANTHROPIC_API_KEY: "sk-ant-test-x" }) === "invalid" && testMode({ NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "sk-ant-api03-x" }) === "invalid", "test mode refuses a non-loopback model or a non-test key");
  const t = runEnv({ PATH: "/bin", NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: "sk-ant-test-x" }, {});
  ok(t.ANTHROPIC_BASE_URL === "http://127.0.0.1:9" && t.ANTHROPIC_API_KEY === "sk-ant-test-x", "test mode passes only a fake key and a loopback model");
}

// Subscription preflight, against a fake claude that reports each sign-in kind.
{
  const F = fixture(), started = path.join(F, "SESSION-STARTED");
  // The launcher passes the fake no extra variables, so its answer comes from a file named by its own path.
  // It also records its arguments, to show the status check runs under the run's own restricted policy.
  const fakeFor = (auth, exit = 0) => { const f = path.join(F, "claude-" + Math.random().toString(36).slice(2)); writeFileSync(f + ".json", auth); writeFileSync(f, `#!/bin/sh\necho "$@" > "${f}.args"\ncase " $* " in *" auth status "*) cat "${f}.json"; exit ${exit};; esac\ntouch "${started}"\n`); chmodSync(f, 0o755); return f; };
  const check = (auth, exit) => preflight(fakeFor(auth, exit), { PATH: process.env.PATH }, F);
  const sub = plan => JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", ...(plan === undefined ? {} : { subscriptionType: plan }) });
  const passing = await Promise.all(["pro", "max", "team", "enterprise", "Max"].map(p => check(sub(p))));
  ok(passing.every(r => r.ok), "a claude.ai login on a Pro, Max, Team or Enterprise plan passes");
  const plans = await Promise.all([undefined, "", "free", "unknown", "max_trial_expired", null].map(p => check(sub(p))));
  ok(plans.every(r => !r.ok && r.why === "plan" && /never falls back/.test(r.say)), "a claude.ai login with no plan, a free plan or an unknown plan is refused");
  const argF = fakeFor(sub("max"));
  await preflight(argF, { PATH: process.env.PATH }, F, '{"hooks":{}}');
  ok(readFileSync(argF + ".args", "utf8").trim() === '--restricted --settings {"hooks":{}} auth status --json', "the status check runs with --restricted and the run's own settings");
  const refused = [
    [{ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }, /billed per use/],
    [{ loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty" }, /billed per use/],
    [{ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, /cloud provider/],
    [{ loggedIn: true, authMethod: "claude.ai", apiProvider: "vertex" }, /cloud provider/],
    [{ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, /can't confirm/],
    [{ loggedIn: true, authMethod: "something_new", apiProvider: "firstParty" }, /can't confirm/],
    [{ loggedIn: false, authMethod: "none" }, /isn't signed in/],
  ];
  const results = await Promise.all(refused.map(([st]) => check(JSON.stringify(st), st.loggedIn ? 0 : 1)));
  ok(results.every((r, i) => !r.ok && refused[i][1].test(r.say) && /never falls back|isn't signed in/.test(r.say)), "API keys, key helpers, cloud providers, token variables, unknown methods and signed-out states are all refused, saying why");
  ok(!(await check("not json")).ok && !(await preflight(path.join(F, "missing"), { PATH: "/nonexistent" }, F)).ok, "unreadable status or a missing Claude Code refuses too");
  const tmp = path.join(F, "tmp"); mkdirSync(tmp);
  const run = spawn(process.execPath, [bridge, "start"], { env: { PATH: process.env.PATH, HOME: path.join(F, "home"), NIGHT_SHIFT_TMP: tmp, NIGHT_SHIFT_CLAUDE: fakeFor(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" })), ANTHROPIC_API_KEY: "sk-ant-api03-canary" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; run.stdout.on("data", d => out += d);
  const code = await new Promise(r => run.on("exit", r));
  ok(code === 4 && /never falls back to paid API use/.test(out) && !existsSync(started) && readdirSync(tmp).length === 0, "on API-key sign-in the launcher stops before starting a session or creating any folder");
}

// The guard fails closed, and a tripped run refuses even allowed tools.
{
  const F = fixture(), run = path.join(F, "run"), ctl = path.join(F, "ctl");
  mkdirSync(run); mkdirSync(ctl);
  const guard = (env, ev) => JSON.parse(execFileSync(process.execPath, [bridge, "guard"], { input: JSON.stringify(ev), env: { PATH: process.env.PATH, ...env } }).toString() || "{}");
  const write = { tool_name: "Write", tool_input: { file_path: path.join(run, "out.md"), content: "x" } };
  const bare = guard({}, write);
  ok(bare.continue === false && bare.hookSpecificOutput.permissionDecision === "deny", "outside the launcher the guard refuses everything");
  ok(guard({ NIGHT_SHIFT_CTL: ctl, NIGHT_SHIFT_RUN_DIR: run }, write).continue === undefined, "inside a clean run an allowed write passes");
  const bad = guard({ NIGHT_SHIFT_CTL: ctl, NIGHT_SHIFT_RUN_DIR: run }, { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } });
  const after = guard({ NIGHT_SHIFT_CTL: ctl, NIGHT_SHIFT_RUN_DIR: run }, write);
  ok(bad.continue === false && existsSync(path.join(ctl, "violation.json")), "a violation ends the session and is recorded");
  ok(after.continue === false && after.hookSpecificOutput.permissionDecision === "deny", "after a violation, even an allowed write is refused");
}

// Revocation is claimed only when the server confirms it; the local reason survives either way.
{
  const F = fixture(), ctl = path.join(F, "ctl"); mkdirSync(ctl);
  writeFileSync(path.join(ctl, "session.json"), JSON.stringify({ token: "cw_" + "0".repeat(48), session: "mcp-unreachable01", site: "http://127.0.0.1:9" }));
  await trip(ctl, "outside_folder", "Read");
  const rev = JSON.parse(readFileSync(path.join(ctl, "revocation.json"), "utf8"));
  const msg = stopMessage(JSON.parse(readFileSync(path.join(ctl, "violation.json"), "utf8")), rev);
  ok(rev.confirmed === false && rev.why === "unreachable", "an unreachable server leaves revocation unconfirmed");
  ok(/couldn't confirm/.test(msg) && !/confirmed the run's access is revoked/.test(msg) && /\.nightshift\/reports/.test(msg), "the stop message says revocation is unconfirmed and where the reason is kept");
  ok(/confirmed the run's access is revoked/.test(stopMessage({ category: "outside_folder" }, { confirmed: true })), "only a server acknowledgement produces the revoked wording");
  const ctl2 = path.join(F, "ctl2"); mkdirSync(ctl2);
  await trip(ctl2, "tool_not_allowed", "Bash");
  ok(JSON.parse(readFileSync(path.join(ctl2, "revocation.json"), "utf8")).why === "no_run" && /before it started/.test(stopMessage({ category: "tool_not_allowed" }, { confirmed: false, why: "no_run" })), "a stop before check-in says no access had been given");
}

// End to end with real Claude Code.
async function scenario(name, plan, opts = {}) {
  const F = fixture(), home = path.join(F, "home"), tmp = path.join(F, "tmp"), cfg = path.join(home, ".claude");
  mkdirSync(cfg, { recursive: true }); mkdirSync(tmp); mkdirSync(path.join(home, "Documents"));
  writeFileSync(path.join(home, "Documents", "secret.txt"), "CANARY-PERSONAL-FILE");
  writeFileSync(path.join(cfg, "CLAUDE.md"), "CANARY-USER-MEMORY");
  writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ permissions: { allow: ["Bash", "Read", "WebFetch"] }, apiKeyHelper: `touch ${F}/APIKEYHELPER-RAN; echo CANARY-HELPER-KEY`, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `touch ${F}/USER-HOOK-RAN` }] }] } }));
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { personal: { command: "sh", args: ["-c", `touch ${F}/USER-MCP-RAN`] } } }));
  writeFileSync(path.join(F, "evil.cjs"), `if (process.env.NIGHT_SHIFT_CTL) require("fs").writeFileSync(${JSON.stringify(F + "/NODE-OPTIONS-RAN")}, "x")`);
  const port = 8900 + Math.floor(Math.random() * 90), log = path.join(F, "model.log"), audit = path.join(F, "audit.log");
  const resolved = JSON.parse(JSON.stringify(plan).replaceAll("$HOME", home));
  const mock = spawn(process.execPath, [path.join(here, "mock-model.mjs"), String(port), log, JSON.stringify(resolved)], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 400));
  const env = { PATH: process.env.PATH, HOME: home, USER: process.env.USER, TMPDIR: tmp, NIGHT_SHIFT_TMP: tmp, NIGHT_SHIFT_SITE: SITE, NIGHT_SHIFT_NO_OPEN: "1",
    NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-test-dummy", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    NIGHT_SHIFT_AUDIT: audit, AWS_SECRET_ACCESS_KEY: "CANARY-ENV-KEY", NODE_OPTIONS: `--require ${F}/evil.cjs`, ...(opts.env || {}) };
  const t0 = Date.now();
  const child = spawn(process.execPath, [bridge, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  if (opts.signal) setTimeout(() => child.kill(opts.signal[0]), opts.signal[1]);
  // A crash: kill Claude Code itself, not the launcher.
  if (opts.crash) setTimeout(() => { try { for (const pid of execFileSync("pgrep", ["-P", String(child.pid)]).toString().trim().split("\n")) process.kill(Number(pid), "SIGKILL"); } catch {} }, opts.crash);
  const code = await new Promise(r => { const t = setTimeout(() => { child.kill("SIGKILL"); r("timeout"); }, 150_000); child.on("exit", c => { clearTimeout(t); r(c); }); });
  mock.kill();
  const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const main = lines.filter(l => l.main);
  const results = Object.fromEntries((main.at(-1)?.results || []).map(r => [r.id, r]));
  const auditLines = existsSync(audit) ? readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const me = existsSync(path.join(home, ".nightshift", "me.json")) ? JSON.parse(readFileSync(path.join(home, ".nightshift", "me.json"), "utf8")) : null;
  const runs = me ? await (await fetch(`${SITE}/api/public/runs/${me.handle}`)).json() : null;
  return { name, F, code, out, secs: (Date.now() - t0) / 1000, main, results, audit: auditLines, me, runs, tmpLeft: readdirSync(tmp).filter(n => n.startsWith("night-shift-")), reports: existsSync(path.join(home, ".nightshift", "reports")) ? readdirSync(path.join(home, ".nightshift", "reports")) : [], all: lines.map(l => l.raw).join("\n") };
}
const J = { name: "mcp__night-shift__join", input: { mission: "indus-script", hours: 1 } };
const CHECK_IN = { name: "mcp__night-shift__check_in", input: {} };
const WRITE = { id: "toolu_write", name: "Write", input: { file_path: "out.md", content: "CANARY-OUTPUT" } };
const localReport = (s, suffix) => { const f = s.reports.find(n => n.endsWith(suffix)); return f ? JSON.parse(readFileSync(path.join(s.F, "home", ".nightshift", "reports", f), "utf8")) : null; };
// After a run ends, its scoped access must be closed on the server: by session over REST, by run id over MCP, and with no run id at all.
async function accessClosed(s, rep) {
  if (!rep?.session || !s.me) return false;
  const q = "/api/indus/query?q=" + encodeURIComponent(JSON.stringify({ op: "summary" }));
  const rest = await fetch(SITE + q, { headers: { authorization: "Bearer " + s.me.token, "x-night-shift-session": rep.session } });
  const mcp = async headers => (await (await fetch(`${SITE}/api/mcp/${s.me.token}`, { method: "POST", headers: { "content-type": "application/json", "x-night-shift-runtime": "claude-restricted/1", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_data", arguments: { op: "summary" } } }) })).json()).result.isError;
  return rest.status === 409 && await mcp({ "x-night-shift-run": rep.session.replace(/^mcp-/, "") }) === true && await mcp({}) === true;
}
const wroteAfter = s => s.audit.some(a => a.tool === "Write" && a.decision === "allow") || /File created/.test(s.results.toolu_write?.text || "");

let claudeOk = false;
try { execFileSync("claude", ["--version"], { stdio: "ignore" }); claudeOk = true; } catch {}
if (!SITE || !claudeOk) console.log("SKIP end-to-end: set SITE to a local Night Shift API and install Claude Code");
else {
  const clean = await scenario("clean", [J, CHECK_IN, WRITE, { name: "mcp__night-shift__report", input: {} }]);
  const toolNames = new Set(clean.main.flatMap(l => l.tools));
  ok(clean.code === 0 && clean.runs?.runs[0]?.status === "completed", "a clean run checks in, writes in its folder, reports and completes");
  ok(wroteAfter(clean), "control: the write check does see an allowed write when one happens");
  ok([...toolNames].every(t => ["Read", "Write", "Edit", "Glob", "Grep"].includes(t) || t.startsWith("mcp__night-shift__")) && toolNames.has("Write") && !toolNames.has("Bash"), "the AI is offered only the five file tools and the Night Shift tools");
  ok(!/CANARY-(USER-MEMORY|ENV-KEY|HELPER-KEY|PERSONAL-FILE)/.test(clean.all), "no personal memory, environment key, helper key or file reaches the model");
  ok(["USER-HOOK-RAN", "USER-MCP-RAN", "APIKEYHELPER-RAN", "NODE-OPTIONS-RAN"].every(f => !existsSync(path.join(clean.F, f))), "the person's own hooks, MCP servers, key helper and NODE_OPTIONS don't run");
  ok(clean.tmpLeft.length === 0 && clean.reports.length === 1, "teardown deletes the run and control folders and keeps the report");
  ok(!existsSync(path.join(clean.F, "home", ".claude", "projects")) || readdirSync(path.join(clean.F, "home", ".claude", "projects"), { recursive: true }).filter(f => String(f).endsWith(".jsonl")).length === 0, "the session isn't saved to the person's Claude folder");

  const seq = await scenario("sequential", [J, CHECK_IN, { name: "Read", input: { file_path: "$HOME/Documents/secret.txt" } }, WRITE]);
  ok(seq.code === 3 && seq.runs?.runs[0]?.status === "stopped" && /outside its own run folder/.test(seq.runs.runs[0].stop_reason || ""), "reading a personal file stops the run, and its report says why");
  ok(!wroteAfter(seq) && !/CANARY-PERSONAL-FILE/.test(seq.all), "nothing leaks and no later write runs");
  const seqStop = seq.reports.find(f => f.endsWith("-stopped.json"));
  ok(await accessClosed(seq, localReport(seq, "-stopped.json")), "after a violation, research calls with that run are refused");
  ok(seqStop && JSON.parse(readFileSync(path.join(seq.F, "home", ".nightshift", "reports", seqStop), "utf8")).revocation_confirmed === true && /confirmed the run's access is revoked/.test(seq.out), "the local stop report and the message both record the server's confirmation");

  const par = await scenario("parallel", [J, CHECK_IN, [{ name: "Read", input: { file_path: "$HOME/Documents/secret.txt" } }, WRITE]]);
  ok(par.code === 3 && par.runs?.runs[0]?.status === "stopped" && !wroteAfter(par) && !/CANARY-PERSONAL-FILE/.test(par.all), "a write in the same turn as a violation doesn't run");

  const unk = await scenario("unknown tool", [J, CHECK_IN, { name: "Bash", input: { command: "cat ~/Documents/secret.txt", description: "x" } }, WRITE]);
  ok(unk.code === 3 && unk.runs?.runs[0]?.status === "stopped" && /tool/.test(unk.runs.runs[0].stop_reason || "") && !wroteAfter(unk), "asking for a disabled tool (no hook fires) still stops the run, with no later write");

  const src = await scenario("personal source", [J, CHECK_IN, { name: "mcp__night-shift__request_source", input: { url: "https://mail.google.com/mail/u/0", why: "x" } }, WRITE]);
  ok(src.code === 3 && src.runs?.runs[0]?.status === "stopped" && /personal source/.test(src.runs.runs[0].stop_reason || "") && !wroteAfter(src), "asking for a personal source stops the run, with no later write");

  const invented = await scenario("invented tool", [J, CHECK_IN, { name: "mcp__night-shift__read_personal_email", input: {} }, WRITE]);
  ok(invented.code === 3 && invented.runs?.runs[0]?.status === "stopped" && !wroteAfter(invented), "an invented Night Shift tool name stops the run, with no later write");
  ok(!new Set(invented.main.flatMap(l => l.tools)).has("mcp__night-shift__schedule_created"), "the launcher's bridge lists only the approved Night Shift tools");

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const c = await scenario("cancel " + sig, [J, CHECK_IN, { sleep: 30_000 }, WRITE], { signal: [sig, 6000] });
    ok(c.code === 130 && /cancelled/.test(c.out) && c.tmpLeft.length === 0 && !wroteAfter(c) && c.secs < 20, `${sig} cancels the run and cleans up`);
    const rep = localReport(c, "-ended.json");
    ok(rep?.server_confirmed === true && /server confirmed/.test(c.out) && c.runs?.runs[0]?.status === "stopped" && c.runs.runs[0].stop_kind === "cancelled" && await accessClosed(c, rep), `${sig}: the server closes the run, the report says cancelled, and later research calls are refused`);
  }

  const quiet = await scenario("no report", [J, CHECK_IN]);
  const quietRep = localReport(quiet, "-ended.json");
  ok(quietRep?.server_confirmed === true && quiet.runs?.runs[0]?.status === "stopped" && quiet.runs.runs[0].stop_kind === "no_report" && /without its report/.test(quiet.out) && await accessClosed(quiet, quietRep), "an AI that stops without reporting has its run closed on the server, with a report saying so");
  const crash = await scenario("crash", [J, CHECK_IN, { sleep: 30_000 }, WRITE], { crash: 6000 });
  const crashRep = localReport(crash, "-ended.json");
  ok(crash.tmpLeft.length === 0 && crashRep?.server_confirmed === true && crash.runs?.runs[0]?.status === "stopped" && crash.runs.runs[0].stop_kind === "no_report" && await accessClosed(crash, crashRep), "if Claude Code crashes after check-in, the run is closed on the server and cleaned up");

  const slow = await scenario("time limit", [J, CHECK_IN, { sleep: 20_000 }, WRITE], { env: { NIGHT_SHIFT_LIMIT_SECONDS: "5" } });
  ok(slow.secs < 15 && /time limit/.test(slow.out) && slow.tmpLeft.length === 0 && !wroteAfter(slow), "the launcher ends a run at its time limit and cleans up");
  const slowRep = localReport(slow, "-ended.json");
  ok(slowRep?.server_confirmed === true && slow.runs?.runs[0]?.status === "stopped" && slow.runs.runs[0].stop_kind === "time_limit" && await accessClosed(slow, slowRep), "at the time limit the server closes the run too, and later research calls are refused");
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
