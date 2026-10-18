// Regression test for the EXPERIMENTAL Codex context restriction (experimental/codex-context.mjs). Stand-in files,
// a fake auth file and a loopback fake model only: no real Codex folder, sign-in or model.
// 1. Positive control: Codex's own options alone still send the stand-in personal instructions.
// 2. The restricted run succeeds, and none of the stand-ins (or the fake auth) are in what reached the model.
// 3. The restricted CLI can still read its auth file. 4. No stand-in file was changed. The fixture is always removed.
// The control runs first, so the restricted run also starts with Codex's own leftover runtime state in CODEX_HOME.
// Passing shows preloaded-context suppression only, not a runner, network limits, real sign-in or billing safety.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextArgs, runRestricted } from "../experimental/codex-context.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };
if (process.platform !== "darwin") { console.log("SKIP macOS only"); process.exit(0); }
let bin = null, version = null;
try { bin = realpathSync(execFileSync("/usr/bin/which", ["codex"]).toString().trim()); version = execFileSync(bin, ["--version"]).toString().trim(); } catch {}
if (!bin) { console.log("SKIP Codex isn't installed"); process.exit(0); }
console.log("INFO " + version);

const F = realpathSync(mkdtempSync(path.join(tmpdir(), "ns-codex-context-")));
const mocks = [];
const cleanup = () => { for (const m of mocks) try { m.kill("SIGKILL"); } catch {} try { if (path.basename(F).startsWith("ns-codex-context-")) rmSync(F, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => process.exit(130));
const deadline = setTimeout(() => { console.log("FAIL the test ran past 4 minutes"); process.exit(1); }, 240_000);

try {
  const codexHome = path.join(F, "codexhome"), home = path.join(F, "home"), work = path.join(F, "work");
  const files = {
    [path.join(codexHome, "AGENTS.md")]: "CANARY-CODEX-AGENTS-MD\n",
    [path.join(codexHome, "AGENTS.override.md")]: "CANARY-CODEX-OVERRIDE\n",
    [path.join(codexHome, "skills", "canary-skill", "SKILL.md")]: "---\nname: canary-skill\ndescription: CANARY-CODEX-SKILL\n---\nx\n",
    [path.join(home, ".agents", "skills", "home-skill", "SKILL.md")]: "---\nname: home-skill\ndescription: CANARY-HOME-AGENTS-SKILL\n---\nx\n",
    [path.join(work, "AGENTS.md")]: "CANARY-PROJECT-AGENTS\n",
    [path.join(codexHome, "auth.json")]: JSON.stringify({ OPENAI_API_KEY: "sk-test-FAKE-AUTH-READ-CANARY" }),
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, c); }
  const canaries = ["CANARY-CODEX-AGENTS-MD", "CANARY-CODEX-OVERRIDE", "CANARY-CODEX-SKILL", "CANARY-HOME-AGENTS-SKILL", "CANARY-PROJECT-AGENTS", "sk-test-FAKE-AUTH-READ-CANARY"];

  const model = async (name, run) => {
    const port = 8960 + Math.floor(Math.random() * 30), log = path.join(F, name + ".log");
    const mock = spawn(process.execPath, [path.join(here, "mock-responses.mjs"), String(port), log, "[]"], { stdio: "ignore" }); mocks.push(mock);
    await new Promise(r => setTimeout(r, 400));
    const provider = ["-c", 'model_provider="mock"', "-c", `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="NS_TEST_KEY"}`, "-m", "test-model", "hello"];
    const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, NS_TEST_KEY: "sk-test-fake" };
    const res = await run(provider, env);
    mock.kill();
    return { ...res, sent: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };

  // 1. Positive control: Codex's own isolation options, without the file restriction.
  const runtime1 = path.join(F, "runtime-control"); mkdirSync(runtime1);
  const control = await model("control", (provider, env) => new Promise(r => { const p = spawn(bin, [...contextArgs({ work, runtime: runtime1 }), ...provider], { cwd: work, env, stdio: ["ignore", "ignore", "ignore"] }); const t = setTimeout(() => p.kill("SIGKILL"), 90_000); p.on("exit", code => { clearTimeout(t); r({ code }); }); }));
  ok(control.code === 0 && control.sent.includes("/responses"), "control: Codex reached the loopback fake model");
  ok(control.sent.includes("CANARY-CODEX-AGENTS-MD") || control.sent.includes("CANARY-CODEX-OVERRIDE"), "control: with Codex's own options only, the stand-in global instructions (AGENTS.override.md, which takes AGENTS.md's place) still reached the model");

  // 2. The same run under the experimental file restriction.
  const restricted = await model("restricted", (provider, env) => runRestricted(bin, [...contextArgs({ work, runtime: path.join(F, "runtime") }), ...provider], { codexHome, home, cwd: work, env, scratch: path.join(F, "runtime") }));
  ok(restricted.code === 0 && restricted.sent.includes("/responses"), "restricted: the run still reached the fake model and finished");
  if (restricted.code !== 0) console.log("INFO restricted exit " + restricted.code + " " + restricted.signal + " " + String(restricted.err).slice(-600).replace(/\n/g, " | "));
  for (const c of canaries) ok(!restricted.sent.includes(c), "restricted: the request doesn't contain " + c);

  // 3. The CLI itself can still read its auth file under the restriction.
  const status = await runRestricted(bin, ["login", "status"], { codexHome, home, cwd: work, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome }, scratch: path.join(F, "runtime-status"), timeoutMs: 30_000 });
  ok(status.code === 0 && /API key/i.test(status.out + status.err), "restricted: codex login status still reads the fake auth file");

  // 4. Nothing the restriction protects was changed.
  ok(Object.entries(files).every(([p, c]) => readFileSync(p, "utf8") === c), "the stand-in instructions, skills and auth file are unchanged");
  console.log("INFO files Codex added to CODEX_HOME: " + (readdirSync(codexHome).filter(n => !Object.keys(files).some(p => path.dirname(p) === codexHome && path.basename(p) === n) && n !== "skills").join(", ") || "none"));
} finally {
  clearTimeout(deadline);
  cleanup();
}
console.log(existsSync(F) ? "FAIL fixture folder left behind: " + F : "PASS fixture folder removed");
if (existsSync(F)) failures++;
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
