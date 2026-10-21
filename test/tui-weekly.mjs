// The Night Shift window end to end: real Claude Code against the fake model (test/mock-model.mjs), a local Night
// Shift API (SITE, with ADMIN_KEY), and the launcher in a pseudo-terminal. It answers "y" when the window asks about
// the weekly swarm and "q" at the end. System commands are logged, not run (NIGHT_SHIFT_FAKE_SYSTEM), so nothing
// is installed and no wake is scheduled.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = process.env.SITE;
let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };
if (!SITE) { console.log("SKIP: set SITE to a fresh local Night Shift API"); process.exit(0); }

// A fresh project with one work task, so next_task always has something to hand out.
const seed = async tag => (await (await fetch(SITE + "/api/admin/projects", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (process.env.ADMIN_KEY || "t") }, body: JSON.stringify({ id: `tui-e2e-${tag}-` + Math.random().toString(36).slice(2, 8), mission: "indus-script", title: "TUI e2e project", summary: "Local test only", seed: [{ key: "look", kind: "work", title: "Profile the jar sign", points: 2, spec: "Local test task." }] }) })).json()).ok;
if (!(await seed("first"))) { console.log("FAIL couldn't seed a local project (ADMIN_KEY?)"); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url)), bridge = path.join(here, "..", "bridge.mjs");
const F = realpathSync(mkdtempSync(path.join(tmpdir(), "ns-tui-"))), home = path.join(F, "home"), tmp = path.join(F, "tmp"), state = path.join(F, "state");
for (const d of [home, tmp, state]) mkdirSync(d);
const sys = path.join(F, "system.log"), agents = path.join(F, "LaunchAgents");

const N = name => "mcp__night-shift__" + name;
const say = text => ({ name: N("narrate"), input: { text } });
const plan = [
  { name: N("join"), input: { mission: "indus-script", hours: 1 } }, { name: N("check_in"), input: {} },
  say("Asking the swarm for a task"), { name: N("next_task"), input: {} },
  say("Writing a plan before touching the data"), { name: N("post_note"), input: { project_id: "$PROJECT", task_id: "$TASK", type: "plan", body: "Look at the task and summarise it." } },
  { name: "Write", input: { file_path: "notes.md", content: "notes" } },
  say("Submitting the work"), { name: N("submit"), input: { project_id: "$PROJECT", task_id: "$TASK", summary: "Looked at it." } },
  { sleep: 5000 },
  say("Writing up tonight's report"), { name: N("report"), input: {} }, { end: true },
  // The launcher's second pass, once new work shows up.
  say("New work: checking in again"), { name: N("check_in"), input: {} }, { name: N("next_task"), input: {} },
  { name: N("post_note"), input: { project_id: "$PROJECT", task_id: "$TASK", type: "plan", body: "Second task." } },
  { name: N("submit"), input: { project_id: "$PROJECT", task_id: "$TASK", summary: "Second task done." } },
  { name: N("report"), input: {} }, { end: true },
];
const port = 8900 + Math.floor(Math.random() * 90), modelLog = path.join(F, "model.log");
const mock = spawn(process.execPath, [path.join(here, "mock-model.mjs"), String(port), modelLog, JSON.stringify(plan)], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 400));

const env = { PATH: process.env.PATH, HOME: home, USER: process.env.USER, TERM: "xterm-256color", COLORTERM: "truecolor", TMPDIR: tmp, NIGHT_SHIFT_TMP: tmp, NIGHT_SHIFT_SITE: SITE,
  NIGHT_SHIFT_STATE_DIR: state, NIGHT_SHIFT_WAIT_SECONDS: "2", NIGHT_SHIFT_FAKE_SYSTEM: sys, NIGHT_SHIFT_LAUNCH_AGENTS: agents,
  NIGHT_SHIFT_TEST_MODEL: "1", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-test-dummy", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
// A pseudo-terminal (120×36) for the launcher; what it draws comes back on stdout and keys go in on stdin.
const PTY = `
import os, pty, sys, fcntl, termios, struct, select
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 36, 120, 0, 0))
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    r, _, _ = select.select([fd, 0], [], [])
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 1024)
        if data: os.write(fd, data)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;
const p = spawn("python3", ["-c", PTY, process.execPath, bridge, "start"], { env, stdio: ["pipe", "pipe", "pipe"] });
let out = "", asked = false, quit = false, seededMore = false, stopped = false;
const quiet = t => (t.match(/queue is quiet/g) || []).length;
let quietAfterSecond = 0;
const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
p.stdout.on("data", d => {
  out += d;
  const t = plain();
  if (!asked && /run it every week\?/.test(t)) { asked = true; setTimeout(() => p.stdin.write("y"), 300); }
  // Waiting for work: add a task so the launcher starts a second pass on its own.
  if (asked && !seededMore && /queue is quiet/.test(t)) { seededMore = true; quietAfterSecond = Infinity; seed("second").then(() => { quietAfterSecond = quiet(plain()); }); }
  // Waiting again after the second pass: stop the shift (q, then y to confirm).
  if (seededMore && !stopped && /new work in the swarm/.test(t) && quiet(t) > quietAfterSecond) { stopped = true; setTimeout(() => p.stdin.write("q"), 300); setTimeout(() => p.stdin.write("y"), 1200); }
  if (stopped && !quit && /✓ saved to your page|not saved:/.test(t) && /shift (stopped|complete)/.test(t)) { quit = true; setTimeout(() => p.stdin.write("q"), 1500); }
});
const code = await new Promise(r => { const t = setTimeout(() => { p.kill("SIGKILL"); r("timeout"); }, 150_000); p.on("exit", c => { clearTimeout(t); r(c); }); });
mock.kill();
if (process.env.DUMP) (await import("node:fs")).writeFileSync(process.env.DUMP, out);
const t = plain(), cmds = existsSync(sys) ? readFileSync(sys, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const me = existsSync(path.join(state, "me.json")) ? JSON.parse(readFileSync(path.join(state, "me.json"), "utf8")) : null;
const pub = me ? await (await fetch(`${SITE}/api/public/runs/${me.handle}`)).json() : null;

ok(code === 0, "the launcher exits cleanly after q (" + code + ")");
ok(/\[\s+ok\s+\]/.test(t) && /check-in/.test(t) && /sandbox/.test(t), "the window shows the boot checks and the check-in");
ok(/log · \d+/.test(t) && /claim next task/.test(t) && /post plan/.test(t) && /submit/.test(t), "the live log shows the real tool calls in plain words");
ok(asked, "after the first submitted task the window asks about the weekly swarm");
ok(cmds.some(c => c[0] === "launchctl" && c[1] === "bootstrap") && (cmds.find(c => c[0] === "osascript")?.[2].match(/pmset schedule wake/g) || []).length === 12, "saying yes installs the launchd agent and asks once for 12 wakes");
ok(existsSync(path.join(agents, "com.nightshift.weekly.plist")) && existsSync(path.join(state, "tools", "bridge.mjs")), "the agent and the pinned tools copy are in place");
ok(/queue is quiet/.test(t) && seededMore && /new work in the swarm/.test(t), "when the AI runs out of work the shift keeps going, and new work starts the AI again");
ok(stopped && /shift stopped/.test(t) && /✓ saved to your page/.test(t), "q ends the shift; the end screen confirms the answer reached the server");
ok(pub?.weekly_choice === "weekly" && !!pub.schedule_confirmed_at, "the server records Join weekly and that the schedule was set up");
ok(pub?.runs?.length === 2 && pub.runs.every(r => r.status === "completed"), "both passes completed normally on the server (" + (pub?.runs || []).map(r => r.status).join(", ") + ")");
ok(pub?.runs?.every(r => r.items?.some(i => i.kind === "work")), "each pass did its own task (the second one after new work appeared)");
ok(/Weekly: .*launchd ok/.test(t) && /unschedule/.test(t), "after the window closes, the transcript says what was installed and how to remove it");
console.log(failures ? `${failures} FAILED` : "all passed");
process.exitCode = failures ? 1 : 0;
