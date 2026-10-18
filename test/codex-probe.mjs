// Checks Codex's own isolation options against the installed Codex CLI: a fixture CODEX_HOME holding stand-in
// personal instructions and a skill, and test/mock-responses.mjs as the model on loopback with a fake key. No ChatGPT
// sign-in, real model or real Codex folder is used.
// PASS means that with these options alone the stand-ins still reach the model. That doesn't cover every possible
// option: the experimental file restriction in experimental/codex-context.mjs (test/codex-context.mjs) does keep them
// out in the same kind of test. Codex stays unavailable either way until a full runner is accepted.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (c, l) => { console.log((c ? "PASS " : "FAIL ") + l); if (!c) failures++; };
let version = null;
try { version = execFileSync("codex", ["--version"]).toString().trim(); } catch {}
if (!version) { console.log("SKIP Codex isn't installed"); process.exit(0); }
console.log("INFO " + version);

const F = realpathSync(mkdtempSync(path.join(tmpdir(), "ns-codex-")));
process.on("exit", () => { try { if (path.basename(F).startsWith("ns-codex-")) rmSync(F, { recursive: true, force: true }); } catch {} });
const home = path.join(F, "codexhome"), work = path.join(F, "work");
mkdirSync(path.join(home, "skills", "canary-skill"), { recursive: true }); mkdirSync(work); mkdirSync(path.join(F, "personal"));
writeFileSync(path.join(home, "AGENTS.md"), "CANARY-CODEX-AGENTS-MD\n");
writeFileSync(path.join(home, "skills", "canary-skill", "SKILL.md"), "---\nname: canary-skill\ndescription: CANARY-CODEX-SKILL\n---\nx\n");
writeFileSync(path.join(work, "AGENTS.md"), "CANARY-PROJECT-AGENTS\n");
const port = 8950 + Math.floor(Math.random() * 40), log = path.join(F, "model.log");
const mock = spawn(process.execPath, [path.join(here, "mock-responses.mjs"), String(port), log, "[]"], { stdio: "ignore" });
await new Promise(r => setTimeout(r, 400));
const before = new Set(readdirSync(home));
const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-C", work, "--sandbox", "read-only",
  ...["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "view_image", "hooks", "skill_search", "goals"].flatMap(f => ["--disable", f]),
  "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"', "-c", 'model_provider="mock"',
  "-c", `model_providers.mock={name="mock",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="NS_TEST_KEY"}`, "-m", "test-model", "hello"];
const code = await new Promise(r => { const p = spawn("codex", args, { cwd: work, env: { PATH: process.env.PATH, HOME: path.join(F, "personal"), CODEX_HOME: home, NS_TEST_KEY: "sk-test-fake" }, stdio: ["ignore", "ignore", "ignore"] }); const t = setTimeout(() => p.kill("SIGKILL"), 90_000); p.on("exit", c => { clearTimeout(t); r(c); }); });
mock.kill();
const sent = existsSync(log) ? readFileSync(log, "utf8") : "";
ok(code === 0 && sent.includes("/responses"), "Codex ran against the loopback fake model");
ok(sent.includes("CANARY-CODEX-AGENTS-MD") || sent.includes("CANARY-CODEX-SKILL"), "with Codex's own options, the stand-in personal instructions or skills still reach the model");
const added = readdirSync(home).filter(n => !before.has(n));
console.log("INFO project AGENTS.md sent: " + sent.includes("CANARY-PROJECT-AGENTS") + "; new files in CODEX_HOME despite --ephemeral: " + (added.join(", ") || "none"));
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
