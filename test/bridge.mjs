// Bridge test: needs a local Night Shift API (SITE env). Uses a temp HOME and a fake opener; never opens a real browser.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = process.env.SITE || "http://127.0.0.1:8799";
const here = path.dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(path.join(tmpdir(), "ns-home-"));
const opened = path.join(home, "opened.txt");
const opener = path.join(home, "opener.sh");
writeFileSync(opener, `#!/bin/sh\necho "$1" >> "${opened}"\n`); chmodSync(opener, 0o755);
let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };

// launched: true simulates the bridge as the launcher starts it (a control folder and the runtime label).
function session({ launched = true } = {}) {
  const ctl = launched ? mkdtempSync(path.join(tmpdir(), "ns-ctl-")) : null;
  const p = spawn("node", [path.join(here, "..", "bridge.mjs")], { env: { ...process.env, HOME: home, NIGHT_SHIFT_SITE: SITE, NIGHT_SHIFT_OPENER: opener, ...(ctl ? { NIGHT_SHIFT_CTL: ctl } : {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0; const waiters = {};
  p.stdout.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters[m.id]?.(m); } });
  const call = (name, args = {}) => new Promise(r => { const n = ++id; waiters[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } }) + "\n"); });
  const text = m => m.result.content[0].text;
  return { call, text, end: () => p.kill() };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s1 = session();
const notJoined = await s1.call("check_in");
ok(s1.text(notJoined).includes("Not joined yet"), "before joining, check_in asks to join");
const j = await s1.call("join", { mission: "indus-script", hours: 1 });
await sleep(1000);
const me = JSON.parse(readFileSync(path.join(home, ".nightshift", "me.json"), "utf8"));
ok(/#key=ok_[0-9a-f]{32}$/.test(me.page_url) && (statSync(path.join(home, ".nightshift", "me.json")).mode & 0o777) === 0o600, "join saves the private page link in a file only the user can read");
const firstOpen = existsSync(opened) ? readFileSync(opened, "utf8").trim() : "(nothing opened)";
ok(firstOpen === me.page_url, "join opens the person's own page automatically" + (firstOpen === me.page_url ? "" : " (got: " + firstOpen + ")"));
ok(!s1.text(j).includes("#key="), "the private key is not echoed into the AI's chat");
const c1 = JSON.parse(s1.text(await s1.call("check_in")));
const c1retry = JSON.parse(s1.text(await s1.call("check_in")));
ok(c1.action === "start" && c1retry.action === "start" && c1retry.session === c1.session, "retrying check_in keeps the same run (no competing session)");
await s1.call("narrate", { text: "run one" });
await s1.call("report");
const c2 = JSON.parse(s1.text(await s1.call("check_in")));
await s1.call("narrate", { text: "run two" });
await s1.call("report");
s1.end();
ok(c1.run?.kind === "first" && c2.run?.kind === "run", "two runs in one process are a first run and then a separate run");
const runs = await (await fetch(`${SITE}/api/public/runs/${me.handle}`)).json();
ok(runs.runs.length === 2 && runs.runs[0].id !== runs.runs[1].id, "the two runs have distinct ids and reports");

const plain = session({ launched: false });
const refused = JSON.parse(plain.text(await plain.call("check_in")));
plain.end();
ok(refused.action === "skip" && /Night Shift line/.test(refused.reason), "a bridge not started by the launcher can't start a run");

writeFileSync(opened, "");
const s2 = session();
const back = JSON.parse(s2.text(await s2.call("check_in")));
await sleep(300);
s2.end();
ok(back.action === "start" && readFileSync(opened, "utf8").trim() === me.page_url, "a returning contributor's check_in reopens their saved page");
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
