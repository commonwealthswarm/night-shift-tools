// Try the Night Shift window yourself, end to end, with nothing real: a local Night Shift API (wrangler, temp
// state), real Claude Code driven by the fake model, and every launchctl/pmset/osascript/open command logged
// instead of run. Press y when it asks about the weekly swarm; nothing is installed.
//
//   node test/try-local.mjs [path to the nightshift app repo, default ../nightshift]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)), tools = path.join(here, "..");
const app = path.resolve(process.argv[2] || path.join(tools, "..", "nightshift"), "api");
if (!existsSync(path.join(app, "wrangler.toml"))) { console.error(`No Night Shift API at ${app}. Pass the nightshift repo path.`); process.exit(1); }
const F = realpathSync(mkdtempSync(path.join(tmpdir(), "ns-try-"))), dirs = Object.fromEntries(["home", "tmp", "state", "api"].map(d => [d, path.join(F, d)]));
for (const d of Object.values(dirs)) mkdirSync(d);
const PORT = 8797, SITE = `http://127.0.0.1:${PORT}`, sys = path.join(F, "system.log");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = (cmd, args, opts = {}) => new Promise(r => spawn(cmd, args, { stdio: "ignore", ...opts }).on("exit", r));

console.log("Starting a local Night Shift API (first time takes a minute)…");
await quiet("npx", ["--yes", "wrangler@4", "d1", "migrations", "apply", "commonwealth", "--local", "--persist-to", dirs.api], { cwd: app, env: { ...process.env, CI: "1" } });
const api = spawn("npx", ["--yes", "wrangler@4", "dev", "--local", "--persist-to", dirs.api, "--ip", "127.0.0.1", "--port", String(PORT), "--var", "ADMIN_KEY:t", "--var", "PUBLIC_BASE:" + SITE], { cwd: app, stdio: "ignore", detached: true, env: { ...process.env, CI: "1" } });
let mock;
const cleanup = () => { try { process.kill(-api.pid); } catch {} try { mock?.kill(); } catch {} };
process.on("exit", cleanup);
for (let i = 0; i < 120; i++) { try { if ((await fetch(SITE + "/api/shift")).ok) break; } catch {} await sleep(500); }
await fetch(SITE + "/api/admin/projects", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify({ id: "try-local", mission: "indus-script", title: "Local try-out", summary: "Local test only", seed: [{ key: "jar", kind: "work", title: "Where does the jar sign sit in an inscription?", points: 2, spec: "Local test task." }] }) });

// The fake model's script: a short first run with pauses so there's time to watch and answer.
const N = name => "mcp__night-shift__" + name, say = text => ({ name: N("narrate"), input: { text } }), P = { project_id: "$PROJECT", task_id: "$TASK" };
const plan = [
  { name: N("join"), input: { mission: "indus-script", hours: 1 } }, say("Checking in for tonight's shift"), { name: N("check_in"), input: {} }, { sleep: 3000 },
  say("Asking the swarm for a task"), { name: N("next_task"), input: {} }, { sleep: 1500 },
  say("Reading the task and what teammates already tried"), { name: N("read_task"), input: P }, { sleep: 1200 }, { name: N("feed"), input: P }, { sleep: 1500 },
  say("Writing a plan before touching the data"), { name: N("post_note"), input: { ...P, type: "plan", body: "Count the jar sign by position and compare with a shuffled baseline." } }, { sleep: 1500 },
  { name: "Write", input: { file_path: "findings.md", content: "# Findings\n" } }, { sleep: 1200 }, { name: N("heartbeat"), input: P }, { sleep: 1500 },
  say("Writing up what the counts show"), { name: N("post_note"), input: { ...P, type: "finding", body: "The jar sign mostly ends the inscriptions it appears in." } }, { sleep: 1500 },
  say("Submitting the work"), { name: N("submit"), input: { ...P, summary: "Positional profile of the jar sign." } }, { sleep: 12000 },
  say("Writing up tonight's report"), { name: N("report"), input: {} },
];
const mport = 8900 + Math.floor(Math.random() * 90);
mock = spawn(process.execPath, [path.join(here, "mock-model.mjs"), String(mport), path.join(F, "model.log"), JSON.stringify(plan)], { stdio: "ignore" });
await sleep(400);

const run = spawn(process.execPath, [path.join(tools, "bridge.mjs"), "start"], { stdio: "inherit", env: {
  PATH: process.env.PATH, HOME: dirs.home, USER: process.env.USER, TERM: process.env.TERM, COLORTERM: process.env.COLORTERM, TERM_PROGRAM: process.env.TERM_PROGRAM, LANG: process.env.LANG,
  TMPDIR: dirs.tmp, NIGHT_SHIFT_TMP: dirs.tmp, NIGHT_SHIFT_SITE: SITE, NIGHT_SHIFT_STATE_DIR: dirs.state,
  NIGHT_SHIFT_FAKE_SYSTEM: sys, NIGHT_SHIFT_LAUNCH_AGENTS: path.join(F, "LaunchAgents"),
  NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mport}`, ANTHROPIC_API_KEY: "sk-ant-test-dummy", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
} });
await new Promise(r => run.on("exit", r));
if (existsSync(sys)) {
  console.log("\nWhat saying yes would have run on this Mac (logged, not run):");
  for (const [cmd, ...args] of readFileSync(sys, "utf8").trim().split("\n").map(JSON.parse)) console.log("  " + cmd + " " + (cmd === "osascript" ? `(admin dialog: ${(args[1].match(/pmset schedule wake/g) || []).length} wake events)` : args.join(" ")));
}
console.log(`\nLeftovers are in ${F} (local API state, logs). Nothing outside it was changed.`);
cleanup(); process.exit(0);
