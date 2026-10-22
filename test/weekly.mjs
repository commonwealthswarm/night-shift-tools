// The weekly schedule. Nothing is installed: NIGHT_SHIFT_FAKE_SYSTEM logs every launchctl, pmset, osascript,
// crontab and open command instead of running it, and all state lives in temp folders.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as weekly from "../weekly.mjs";

let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = () => realpathSync(mkdtempSync(path.join(tmpdir(), "ns-weekly-")));
const PT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" });

// When.
{
  const starts = weekly.swarmStarts(Date.parse("2026-10-21T12:00:00Z"));
  ok(starts.length === 12 && starts.every(t => PT.format(t) === "Sun 20:00"), "the next 12 starts are all Sunday 8 PM Pacific");
  ok(new Date(starts[0]).toISOString() === "2026-10-26T03:00:00.000Z" && new Date(starts[1]).toISOString() === "2026-11-02T04:00:00.000Z", "the Pacific clock change between them is followed (PDT, then PST)");
  ok(starts.every((t, i) => !i || t - starts[i - 1] >= 6.9 * 86_400_000), "one start a week");
  const during = weekly.swarmStarts(Date.parse("2026-10-26T05:00:00Z"), 1);
  ok(new Date(during[0]).toISOString() === "2026-11-02T04:00:00.000Z", "during a live swarm, the next start is next week's");
  const slots = weekly.calendarSlots(starts);
  ok(slots.length >= weekly.RETRIES.length && slots.every(s => s.Weekday >= 0 && s.Weekday <= 6) && new Set(slots.map(s => `${s.Weekday}-${s.Hour}-${s.Minute}`)).size === slots.length, "launchd gets each distinct local start and retry once");
  const local = new Date(starts[0]);
  ok(slots.some(s => s.Weekday === local.getDay() && s.Hour === local.getHours() && s.Minute === local.getMinutes()), "the first slot is the start on this computer's clock");
  ok(/^\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d$/.test(weekly.pmsetDate(starts[0])), "wake dates use pmset's MM/dd/yy HH:mm:ss");
  const sched = "Repeating power events:\n  wakepoweron at 5:00AM weekdays only\nScheduled power events:\n [0]  wake at 10/21/2099 07:34:13 by 'com.apple.alarm'\n [1]  wake at 11/02/2099 20:01:00 by 'nightshift'\n [2]  wake at 01/02/2001 20:01:00 by 'nightshift'";
  ok(weekly.ourWakes(sched).length === 1, "only our own future wakes are read back; the person's and past ones are left alone");
}

// Install and uninstall, with every system command logged instead of run.
const setup = (extra = {}) => {
  const F = fixture(), state = path.join(F, "state"), agents = path.join(F, "LaunchAgents"), log = path.join(F, "system.log");
  mkdirSync(state);
  return { F, log, agents, env: { ...process.env, NIGHT_SHIFT_STATE_DIR: state, NIGHT_SHIFT_SITE: "http://127.0.0.1:9", NIGHT_SHIFT_LAUNCH_AGENTS: agents, NIGHT_SHIFT_FAKE_SYSTEM: log, NIGHT_SHIFT_FAKE_SCHED: " [0]  wake at 10/26/2099 20:01:00 by 'nightshift'\n [1]  wake at 10/21/2099 07:34:13 by 'com.apple.alarm'", ...extra } };
};
const commands = log => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];

if (process.platform === "darwin") {
  const { F, log, agents, env } = setup();
  const steps = [];
  const r = await weekly.install({ claude: "/opt/claude/bin/claude", env, step: (...a) => steps.push(a), now: Date.parse("2026-10-21T12:00:00Z") });
  const p = weekly.paths(env), cmds = commands(log);
  ok(r.ok && r.wakes === 12, "install reports the launchd agent and 12 wakes");
  ok(existsSync(path.join(p.tools, "bridge.mjs")) && existsSync(path.join(p.tools, "assets", "seal.json")) && existsSync(path.join(p.tools, "tui.mjs")), "a pinned copy of these tools is kept in the Night Shift folder");
  let plist = null;
  try { plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(agents, weekly.LABEL + ".plist")]).toString()); } catch {}
  ok(plist && plist.Label === weekly.LABEL && plist.ProgramArguments[1] === path.join(p.tools, "bridge.mjs") && plist.ProgramArguments.slice(-2).join(" ") === "start --weekly", "the agent runs the pinned copy's start --weekly");
  ok(plist && Array.isArray(plist.StartCalendarInterval) && plist.StartCalendarInterval.length >= 4 && !plist.StartInterval && !plist.RunAtLoad, "it fires on calendar slots, not every few minutes or at login");
  ok(plist && plist.EnvironmentVariables.NIGHT_SHIFT_CLAUDE === "/opt/claude/bin/claude" && plist.EnvironmentVariables.PATH.split(":").includes("/opt/claude/bin"), "it names Claude Code by full path under launchd's bare environment");
  ok(cmds.some(c => c[0] === "launchctl" && c[1] === "bootout") && cmds.some(c => c[0] === "launchctl" && c[1] === "bootstrap" && c[2] === `gui/${process.getuid()}`), "an older agent is replaced, then the new one is loaded into the person's session");
  const admin = cmds.filter(c => c[0] === "osascript");
  const script = admin[0]?.[2] || "";
  ok(admin.length === 1 && /with administrator privileges/.test(script) && /with prompt/.test(script), "wakes are added in one macOS administrator dialog");
  ok((script.match(/pmset schedule wake/g) || []).length === 12 && (script.match(/pmset schedule cancel wake \\"10\/26\/99 20:01:00\\" nightshift/g) || []).length === 1, "our old wake is cancelled and 12 new ones are added, all owned by 'nightshift'");
  ok(!/pmset repeat|cancelall|com\.apple/.test(script), "the person's repeating wake and other programs' wakes are never touched");
  const watch = readFileSync(p.watch, "utf8");
  ok(/NIGHT_SHIFT_FROM_SCHEDULE=1/.test(watch) && watch.includes(path.join(p.tools, "bridge.mjs")) && /start' '--weekly'/.test(watch), "the Terminal window script runs the same pinned start --weekly");
  ok(steps.filter(s => s[3]).map(s => s[0] + ":" + s[3]).join(" ") === "copy:ok launchd:ok wake:ok", "progress is reported step by step");

  const st = await weekly.status(env);
  ok(st.installed && st.wakes === 1, "status reads the installed agent and our wakes");
  writeFileSync(log, "");
  await weekly.uninstall({ env });
  const un = commands(log);
  ok(!existsSync(path.join(agents, weekly.LABEL + ".plist")) && !existsSync(p.tools) && un.some(c => c[0] === "launchctl" && c[1] === "bootout") && /pmset schedule cancel wake/.test(un.find(c => c[0] === "osascript")?.[2] || ""), "unschedule removes the agent, the pinned copy and our wakes");

  const denied = setup({ NIGHT_SHIFT_FAKE_DENY: "1" });
  const dsteps = [];
  const dr = await weekly.install({ claude: "/x/claude", env: denied.env, step: (...a) => dsteps.push(a) });
  ok(dr.ok && dr.wakes === 0 && dsteps.some(s => s[0] === "wake" && s[3] === "skip"), "if the person declines the administrator dialog, the schedule still runs when the Mac is awake");

  const opened = setup();
  ok(!(await weekly.openWatchWindow(opened.env)), "no Terminal window is opened before anything is installed");
  await weekly.install({ claude: "/x/claude", env: opened.env });
  writeFileSync(opened.log, "");
  ok(await weekly.openWatchWindow(opened.env) && commands(opened.log).some(c => c[0] === "open" && c[1] === "-a" && c[2] === "Terminal"), "a scheduled start opens the watch script in Terminal");
}

// The fake system is only for separate test state.
{
  let threw = false;
  try { await weekly.system("pmset", ["-g", "sched"], { NIGHT_SHIFT_FAKE_SYSTEM: "/tmp/x" }); } catch { threw = true; }
  ok(threw, "logging instead of running system commands is refused outside a loopback test state");
}

// One run at a time.
{
  const { env } = setup();
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "ignore" });
  writeFileSync(path.join(env.NIGHT_SHIFT_STATE_DIR, "run.lock"), String(sleeper.pid));
  ok(weekly.lock(env) === null, "a second run doesn't start while another is going");
  sleeper.kill(); await new Promise(r => sleeper.on("exit", r));
  const unlock = weekly.lock(env);
  ok(typeof unlock === "function", "a stale lock from a run that died is taken over");
  unlock();
  ok(!existsSync(path.join(env.NIGHT_SHIFT_STATE_DIR, "run.lock")), "the lock is released");
}

// A weekly answer waits on disk until a run's report lets the server take it; unschedule clears it.
if (process.platform === "darwin") {
  const { env } = setup();
  ok(weekly.pendingChoice(undefined, env) === null, "no answer is pending at first");
  weekly.pendingChoice({ choice: "weekly", scheduled: true }, env);
  ok(weekly.pendingChoice(undefined, env)?.choice === "weekly", "a weekly answer is kept until it reaches the server");
  await weekly.uninstall({ env });
  ok(weekly.pendingChoice(undefined, env) === null, "unschedule drops a pending answer");
}

// Another process holding the lock (taken the same atomic way) keeps this one out until it lets go.
{
  const { env } = setup();
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `const w = await import(${JSON.stringify(path.join(here, "..", "weekly.mjs"))}); const u = w.lock(); console.log(u ? "held" : "refused"); setTimeout(() => { u && u(); }, 1500);`], { env, stdio: ["ignore", "pipe", "inherit"] });
  const said = await new Promise(r => holder.stdout.once("data", d => r(String(d).trim())));
  const mine = weekly.lock(env);
  ok(said === "held" && mine === null && weekly.lockHeld(env), "while another run holds the lock, a second one is refused and sees it held");
  await new Promise(r => holder.on("exit", r));
  const after = weekly.lock(env);
  ok(typeof after === "function", "once it lets go, the lock can be taken");
  after();
}

// The window survives the replies a real server or bridge can give (errors, plain text, odd inputs).
{
  const { createTui } = await import("../tui.mjs");
  const t = createTui({});
  let threw = null;
  const call = (name, input, text, is_error = false) => { const id = "x" + Math.random(); t.stream({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__night-shift__" + name, input }] } }); t.stream({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: [{ type: "text", text }] }] } }); };
  try {
    call("query_data", { op: "sign", sign_id: 342 }, JSON.stringify({ ok: false, error: "post a plan first" }), true);
    call("query_data", { op: "sign", sign_id: 342 }, "plain text reply");
    call("query_data", { op: "sequence", signs: "342,59" }, "{}");
    call("query_data", { op: "texts", text_numbers: [1] }, JSON.stringify({ texts: [{ text_number: 1 }] }));
    call("report", {}, "not json");
  } catch (e) { threw = e; }
  ok(!threw, "error results, plain-text replies and odd query inputs don't throw in the window" + (threw ? ": " + threw.message : ""));
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exitCode = failures ? 1 : 0;
