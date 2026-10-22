// The weekly run on this computer. Installed only when the person says yes in the Night Shift window, and removed
// with `unschedule`. On macOS it is three things:
// - a copy of these exact tools in ~/.nightshift/tools, so the schedule runs the version the person chose and
//   never fetches code;
// - a launchd agent that runs `start --weekly` at the Sunday swarm start (8 PM US Pacific, converted to this
//   computer's clock), with a few retries. The server still decides whether a run may start;
// - one-off wake events owned by "nightshift", one minute after each of the next 12 starts, approved in macOS's
//   own administrator dialog. A sleeping Mac wakes and launchd runs the start it missed. A repeating pmset wake
//   isn't used: macOS allows only one, and it would replace the person's own.
// On Linux a crontab entry starts the run when the computer is awake; nothing wakes it.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, renameSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir } from "./state.mjs";

export const LABEL = "com.nightshift.weekly";
export const WAKE_OWNER = "nightshift";
export const WEEKS = 12;
// Minutes after the swarm start: the first try, then retries for a network that is slow to come back after a wake.
export const RETRIES = [0, 5, 20, 60];
const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOL_FILES = ["bridge.mjs", "launcher.mjs", "providers.mjs", "state.mjs", "budget.mjs", "owner-recovery.mjs", "tui.mjs", "weekly.mjs", "package.json", "assets/seal.json"];

// ── when ────────────────────────────────────────────────────────────────────────────────────────────────
const PT = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const wall = ms => Object.fromEntries(PT.formatToParts(new Date(ms)).filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
const offset = ms => { const w = wall(ms); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000; };
const pacific = (y, m, d, hh) => { const naive = Date.UTC(y, m - 1, d, hh); return naive - offset(naive - offset(naive)); };

// The next n Sunday 8 PM Pacific swarm starts after `from`, as exact instants.
export function swarmStarts(from = Date.now(), n = WEEKS) {
  const w = wall(from), out = [];
  for (let delta = 0; out.length < n && delta < 7 * n + 8; delta++) {
    const c = new Date(Date.UTC(w.year, w.month - 1, w.day + delta));
    if (c.getUTCDay() !== 0) continue;
    const t = pacific(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), 20);
    if (t > from) out.push(t);
  }
  return out;
}

// launchd fires on this computer's clock, so every local weekday/hour/minute the next starts (and retries) land on.
export function calendarSlots(starts) {
  const seen = new Map();
  for (const s of starts) for (const r of RETRIES) {
    const d = new Date(s + r * 60_000), slot = { Weekday: d.getDay(), Hour: d.getHours(), Minute: d.getMinutes() };
    seen.set(`${slot.Weekday}-${slot.Hour}-${slot.Minute}`, slot);
  }
  return [...seen.values()];
}

const pad = n => String(n).padStart(2, "0");
export const pmsetDate = ms => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const wakeTimes = starts => starts.map(s => s + 60_000);

// Our own future wakes, read back from `pmset -g sched` ("[0]  wake at 10/26/2026 20:01:00 by 'nightshift'").
export function ourWakes(sched, now = Date.now()) {
  const out = [];
  for (const m of String(sched).matchAll(/wake at (\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d) by '([^']*)'/g)) {
    if (m[7] !== WAKE_OWNER) continue;
    const t = new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime();
    if (t > now) out.push(t);
  }
  return out;
}

// ── where ───────────────────────────────────────────────────────────────────────────────────────────────
export function paths(env = process.env) {
  const dir = stateDir(env);
  return {
    tools: join(dir, "tools"), dir: join(dir, "schedule"), log: join(dir, "schedule", "weekly.log"), watch: join(dir, "schedule", "watch.command"),
    plist: join(env.NIGHT_SHIFT_LAUNCH_AGENTS || join(homedir(), "Library", "LaunchAgents"), LABEL + ".plist"),
  };
}

const xml = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function weeklyPlist({ argv, env, slots, log }) {
  const dict = o => `<dict>${Object.entries(o).map(([k, v]) => `<key>${xml(k)}</key>${typeof v === "number" ? `<integer>${v}</integer>` : `<string>${xml(v)}</string>`}`).join("")}</dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map(a => `<string>${xml(a)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>${dict(env)}
  <key>StartCalendarInterval</key><array>${slots.map(dict).join("")}</array>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}
const sh = v => "'" + String(v).replace(/'/g, "'\\''") + "'";

// ── doing ───────────────────────────────────────────────────────────────────────────────────────────────
// Every system command goes through here. NIGHT_SHIFT_FAKE_SYSTEM (test state only) logs commands instead.
export function system(cmd, args, env = process.env) {
  if (env.NIGHT_SHIFT_FAKE_SYSTEM) {
    if (!env.NIGHT_SHIFT_STATE_DIR) throw new Error("NIGHT_SHIFT_FAKE_SYSTEM is only for a separate test state");
    stateDir(env); // throws unless that state is absolute and the API is loopback
    writeFileSync(env.NIGHT_SHIFT_FAKE_SYSTEM, JSON.stringify([cmd, ...args]) + "\n", { flag: "a" });
    const fake = cmd === "pmset" ? (env.NIGHT_SHIFT_FAKE_SCHED || "") : "";
    return Promise.resolve({ code: cmd === "osascript" && env.NIGHT_SHIFT_FAKE_DENY === "1" ? 1 : 0, out: fake });
  }
  return new Promise(r => {
    let p; try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); } catch { return r({ code: 127, out: "" }); }
    let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    p.on("exit", code => r({ code, out })); p.on("error", () => r({ code: 127, out: "" }));
  });
}

// Copies these tools into ~/.nightshift/tools, replacing an older copy in one rename.
export function copyTools(to, from = HERE) {
  const tmp = to + ".new-" + process.pid;
  rmSync(tmp, { recursive: true, force: true });
  for (const f of TOOL_FILES) if (existsSync(join(from, f))) { mkdirSync(dirname(join(tmp, f)), { recursive: true }); cpSync(join(from, f), join(tmp, f)); }
  rmSync(to, { recursive: true, force: true });
  renameSync(tmp, to);
  return join(to, "bridge.mjs");
}

// Installs the weekly run. step(id, key, value, state) reports progress; state is null while working, then
// "ok", "skip" or "fail". Resolves { ok, wakes, starts }.
export async function install({ claude, step = () => {}, env = process.env, now = Date.now() } = {}) {
  const p = paths(env), starts = swarmStarts(now);
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  step("copy", "tools", "copying this version…");
  const bridge = copyTools(p.tools);
  step("copy", "tools", "~/.nightshift/tools (pinned copy)", "ok");
  const path = [...new Set([dirname(process.execPath), claude ? dirname(claude) : null, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean))].join(":");
  const runEnvVars = { PATH: path, ...(claude ? { NIGHT_SHIFT_CLAUDE: claude } : {}), ...(env.NIGHT_SHIFT_SITE ? { NIGHT_SHIFT_SITE: env.NIGHT_SHIFT_SITE } : {}), ...(env.NIGHT_SHIFT_STATE_DIR ? { NIGHT_SHIFT_STATE_DIR: env.NIGHT_SHIFT_STATE_DIR } : {}) };
  const argv = [process.execPath, bridge, "start", "--weekly"];
  // The scheduled start opens this in Terminal, so the person can watch; it carries the same environment.
  writeFileSync(p.watch, `#!/bin/sh\n${Object.entries(runEnvVars).map(([k, v]) => `export ${k}=${sh(v)}`).join("\n")}\nexport NIGHT_SHIFT_FROM_SCHEDULE=1\nexec ${argv.map(sh).join(" ")}\n`, { mode: 0o700 });
  chmodSync(p.watch, 0o700);
  const first = new Date(starts[0]).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }).toLowerCase();

  if (process.platform === "darwin") {
    step("launchd", "launchd", "installing agent…");
    mkdirSync(dirname(p.plist), { recursive: true });
    writeFileSync(p.plist, weeklyPlist({ argv, env: runEnvVars, slots: calendarSlots(starts), log: p.log }), { mode: 0o644 });
    const uid = String(process.getuid());
    await system("launchctl", ["bootout", `gui/${uid}/${LABEL}`], env);
    const boot = await system("launchctl", ["bootstrap", `gui/${uid}`, p.plist], env);
    if (boot.code !== 0) { step("launchd", "launchd", "launchctl refused the agent: " + boot.out.trim().slice(0, 80), "fail"); return { ok: false, wakes: 0, starts }; }
    step("launchd", "launchd", `${LABEL} · ${first} local`, "ok");
    step("wake", "wake", "asking macOS for permission…");
    const wakes = await scheduleWakes(starts, env);
    step("wake", "wake", wakes.ok ? `${wakes.n} sundays · owner '${WAKE_OWNER}'` : "not approved · runs only if awake", wakes.ok ? "ok" : "skip");
    return { ok: true, wakes: wakes.ok ? wakes.n : 0, starts };
  }
  if (process.platform === "linux") {
    step("cron", "cron", "adding crontab entry…");
    const cur = await system("crontab", ["-l"], env), keep = (cur.code === 0 ? cur.out : "").split("\n").filter(l => l && !l.includes("# night-shift-weekly"));
    const envPrefix = "env " + Object.entries(runEnvVars).map(([k, v]) => `${k}=${sh(v)}`).join(" ");
    const lines = calendarSlots(starts).map(s => `${s.Minute} ${s.Hour} * * ${s.Weekday} ${envPrefix} ${argv.map(sh).join(" ")} >> ${sh(p.log)} 2>&1 # night-shift-weekly`);
    const tab = join(p.dir, "crontab.txt");
    writeFileSync(tab, [...keep, ...lines].join("\n") + "\n", { mode: 0o600 });
    const r = await system("crontab", [tab], env);
    step("cron", "cron", r.code === 0 ? `${first} local · no wake on linux` : "crontab refused the entry", r.code === 0 ? "ok" : "fail");
    return { ok: r.code === 0, wakes: 0, starts };
  }
  step("os", "schedule", "weekly runs can't be scheduled on this system yet", "fail");
  return { ok: false, wakes: 0, starts };
}

// One administrator dialog: cancel our old wakes, add the next ones.
export async function scheduleWakes(starts, env = process.env) {
  const sched = await system("pmset", ["-g", "sched"], env);
  const old = ourWakes(sched.out);
  const cmds = [...old.map(t => `/usr/bin/pmset schedule cancel wake "${pmsetDate(t)}" ${WAKE_OWNER}`), ...wakeTimes(starts).map(t => `/usr/bin/pmset schedule wake "${pmsetDate(t)}" ${WAKE_OWNER}`)];
  const r = await adminShell(cmds.join(" ; "), "Night Shift wants to wake this Mac for the weekly swarm (Sundays, 8 PM Pacific), so your AI can join it. This only adds wake events named 'nightshift'.", env);
  return { ok: r.code === 0, n: starts.length };
}
const applescriptString = s => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
const adminShell = (script, prompt, env) => system("osascript", ["-e", `do shell script ${applescriptString(script)} with administrator privileges with prompt ${applescriptString(prompt)}`], env);

export async function uninstall({ step = () => {}, env = process.env } = {}) {
  const p = paths(env);
  if (process.platform === "darwin") {
    await system("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], env);
    rmSync(p.plist, { force: true });
    step("launchd", "launchd", "agent removed", "ok");
    const old = ourWakes((await system("pmset", ["-g", "sched"], env)).out);
    if (old.length) {
      const r = await adminShell(old.map(t => `/usr/bin/pmset schedule cancel wake "${pmsetDate(t)}" ${WAKE_OWNER}`).join(" ; "), "Night Shift wants to remove its wake events for the weekly swarm.", env);
      step("wake", "wake", r.code === 0 ? `${old.length} wake events removed` : "wake events left in place (not approved)", r.code === 0 ? "ok" : "skip");
    } else step("wake", "wake", "none scheduled", "ok");
  } else if (process.platform === "linux") {
    const cur = await system("crontab", ["-l"], env);
    if (cur.code === 0 && cur.out.includes("# night-shift-weekly")) {
      const tab = join(p.dir, "crontab.txt");
      writeFileSync(tab, cur.out.split("\n").filter(l => l && !l.includes("# night-shift-weekly")).join("\n") + "\n", { mode: 0o600 });
      await system("crontab", [tab], env);
    }
    step("cron", "cron", "crontab entry removed", "ok");
  }
  rmSync(p.tools, { recursive: true, force: true }); rmSync(p.watch, { force: true }); pendingChoice(null, env);
  step("tools", "tools", "pinned copy removed", "ok");
}

export async function status(env = process.env) {
  const p = paths(env), installed = existsSync(p.plist) || existsSync(join(p.tools, "bridge.mjs"));
  const wakes = process.platform === "darwin" && installed ? ourWakes((await system("pmset", ["-g", "sched"], env)).out) : [];
  return { installed, wakes: wakes.length, next_wake: wakes.length ? Math.min(...wakes) : null };
}

// A scheduled start opens Terminal so the person can watch. Returns false if it couldn't, so the run goes on
// without a window.
export async function openWatchWindow(env = process.env) {
  const p = paths(env);
  if (process.platform !== "darwin" || !existsSync(p.watch)) return false;
  return (await system("open", ["-a", "Terminal", p.watch], env)).code === 0;
}

// One run at a time on this computer. The lock is created atomically; one whose process is gone, or that is older
// than any shift could be (a reused process id), is stale and taken over.
const LOCK_STALE_MS = 12 * 3_600_000;
const lockFile = env => join(stateDir(env), "run.lock");
export function lockHeld(env = process.env) {
  const f = lockFile(env);
  try {
    const pid = Number(readFileSync(f, "utf8"));
    if (!pid || pid === process.pid || Date.now() - statSync(f).mtimeMs > LOCK_STALE_MS) return false;
    process.kill(pid, 0); return true;
  } catch { return false; }
}
export function lock(env = process.env) {
  const f = lockFile(env);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try { writeFileSync(f, String(process.pid), { mode: 0o600, flag: "wx" }); return () => { try { if (Number(readFileSync(f, "utf8")) === process.pid) rmSync(f); } catch {} }; }
    catch (e) { if (e.code !== "EEXIST" || lockHeld(env)) return null; rmSync(f, { force: true }); }
  }
  return null;
}

// The weekly answer waiting for a run whose report is in (the server takes it only then). null clears it.
export function pendingChoice(value, env = process.env) {
  const f = join(paths(env).dir, "pending-choice.json");
  if (value === undefined) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } }
  if (value === null) return void rmSync(f, { force: true });
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ ...value, at: Date.now() }), { mode: 0o600 });
}
