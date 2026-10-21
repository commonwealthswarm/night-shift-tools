// What each AI service can and can't guarantee before a run starts. Anything Night Shift can't confirm stops the run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// The oldest Claude Code with every flag the launcher relies on (restricted mode, --tools, --strict-mcp-config,
// --permission-prompts). Newer versions run: whatever they add, the PreToolUse guard and the stream scan still
// end the run on any tool outside the allowed list.
export const MIN_CLAUDE_VERSION = "2.1.299";
const atLeast = (v, min) => { const a = v.split(".").map(Number), b = min.split(".").map(Number); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

// Managed (organization) settings load even in restricted mode and could add hooks, MCP servers or a credential.
// These are the documented file and profile locations; server-managed settings have no documented local marker.
export const MANAGED_PATHS = {
  darwin: ["/Library/Application Support/ClaudeCode/managed-settings.json", "/Library/Application Support/ClaudeCode/managed-mcp.json", "/Library/Application Support/ClaudeCode/managed-settings.d", "/Library/Managed Preferences/com.anthropic.claudecode.plist"],
  linux: ["/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-mcp.json", "/etc/claude-code/managed-settings.d"],
  win32: ["C:\\Program Files\\ClaudeCode\\managed-settings.json", "C:\\Program Files\\ClaudeCode\\managed-mcp.json", "C:\\Program Files\\ClaudeCode\\managed-settings.d"],
};

export function run(bin, args, env, cwd, timeoutMs = 20_000) {
  return new Promise(r => {
    let p;
    try { p = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] }); } catch { return r({ code: 127, out: "" }); }
    let out = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => out += d);
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", code => { clearTimeout(t); r({ code, out }); });
    p.on("error", () => { clearTimeout(t); r({ code: 127, out: "" }); });
  });
}

export async function claudeVersion(bin, env, cwd) {
  const r = await run(bin, ["--version"], env, cwd);
  const v = (r.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
  if (r.code === 127) return { ok: false, why: "missing", say: "Claude Code wasn't found. Install it from claude.com/code, sign in with your Claude subscription, then run this line again." };
  if (!v || !atLeast(v, MIN_CLAUDE_VERSION)) return { ok: false, why: "version", version: v, say: `Claude Code ${v || "(unknown version)"} is older than ${MIN_CLAUDE_VERSION}, which Night Shift's privacy limits need. Update it (claude update), then run this line again.` };
  return { ok: true, version: v };
}

export function managedSettings(paths = MANAGED_PATHS[process.platform] || []) {
  const found = paths.filter(p => existsSync(p));
  return found.length ? { ok: false, why: "managed", found, say: "This computer has organization-managed Claude Code settings, which apply even inside Night Shift's limits and could change them. Night Shift didn't start." } : { ok: true };
}

// Contributor-selected overflow on the verified subscription is allowed. Night Shift neither reads nor changes
// that account setting. This notice is not proof of the setting or a zero-cost guarantee. API-key/cloud billing
// and silent credential fallback remain blocked by the effective-auth preflight and minimal environment.
export const SUBSCRIPTION_USAGE_NOTICE = "Night Shift uses your signed-in Claude subscription. Your existing account settings apply: if you enabled extra usage, this run may incur additional charges. Night Shift does not change those settings or switch to API-key billing.";

// With Codex 0.163.0's own options (test/codex-probe.mjs), Codex still sent the person's own global instructions and
// skills to the model and wrote state into $CODEX_HOME. An experimental macOS file restriction
// (experimental/codex-context.mjs, test/codex-context.mjs) kept them out in a test with stand-in files, but it isn't a
// runner: real sign-in, network limits and stopping a run aren't covered. Contributor-selected subscription
// overflow is allowed; it is not the reason Codex remains unavailable.
export const CODEX_BLOCKERS = [
  "With Codex 0.163.0's own options, Codex still sent your personal Codex instructions and skills to the model. An experimental file restriction kept them out in a test with stand-in files, but it hasn't been accepted as a full, safe way to run Codex yet.",
  "Codex stays unavailable until its complete privacy boundary, effective subscription authentication and stop controls are implemented and tested.",
];
export async function codexState(bin, env, cwd) {
  const v = await run(bin, ["--version"], env, cwd);
  if (v.code === 127) return { ok: false, why: "missing", say: "Codex wasn't found on this computer. Night Shift doesn't run on Codex yet anyway." };
  const login = await run(bin, ["login", "status"], env, cwd);
  const auth = /ChatGPT/i.test(login.out) ? "chatgpt" : /API key/i.test(login.out) ? "api_key" : /not logged in/i.test(login.out) ? "signed_out" : "unknown";
  return { ok: false, why: "codex_unsupported", version: (v.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || null, auth, say: "Night Shift doesn't run on Codex yet. " + CODEX_BLOCKERS.join(" ") + " Nothing was started." };
}

// A provider usage rejection still ends the run: no launcher retry, other credential or API-key fallback.
export const USAGE_LIMIT = /usage limit|limit reached|rate[ _-]?limit|429|too many requests/i;
