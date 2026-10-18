// What each AI service can and can't guarantee before a run starts. Anything Night Shift can't confirm stops the run.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Claude Code versions whose restricted mode, hooks and stream were tested with Night Shift's boundary.
export const TESTED_CLAUDE_VERSIONS = new Set(["2.1.299"]);

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
  if (!v || !TESTED_CLAUDE_VERSIONS.has(v)) return { ok: false, why: "version", version: v, say: `Claude Code ${v || "(unknown version)"} hasn't been tested with Night Shift's privacy limits yet (tested: ${[...TESTED_CLAUDE_VERSIONS].join(", ")}), so it didn't start.` };
  return { ok: true, version: v };
}

export function managedSettings(paths = MANAGED_PATHS[process.platform] || []) {
  const found = paths.filter(p => existsSync(p));
  return found.length ? { ok: false, why: "managed", found, say: "This computer has organization-managed Claude Code settings, which apply even inside Night Shift's limits and could change them. Night Shift didn't start." } : { ok: true };
}

// Night Shift must be able to show that a run stays inside the plan's included usage. Claude Code's sign-in status
// says which plan is in use but not whether paid extra usage is switched on, so this can't be shown yet.
export function includedUsageOnly(status) {
  return { ok: false, why: "extra_usage_unverified", say: "Night Shift can't yet confirm from this computer that a run would stay within your plan's included usage (paid extra usage may be switched on for your account), so it didn't start. Nothing was charged." };
}

// In the tested configuration (Codex 0.163.0 with the isolation options in test/codex-probe.mjs), Codex still sent
// the person's own Codex instructions
// ($CODEX_HOME/AGENTS.md) and skills to the model, and wrote state into $CODEX_HOME. Keeping those out would
// mean changing the person's Codex setup, so Codex runs don't start. Paid ChatGPT credits after the included
// limits also can't be ruled out.
export const CODEX_BLOCKERS = [
  "In the configuration Night Shift tested (Codex 0.163.0 with every isolation option it tried), Codex still sent your personal Codex instructions (AGENTS.md in your Codex folder) and your skills to the model, and Night Shift can't keep them out without changing your Codex setup.",
  "Night Shift can't yet confirm that a Codex run would stay within your ChatGPT plan's included usage rather than paid credits.",
];
export async function codexState(bin, env, cwd) {
  const v = await run(bin, ["--version"], env, cwd);
  if (v.code === 127) return { ok: false, why: "missing", say: "Codex wasn't found on this computer. Night Shift doesn't run on Codex yet anyway." };
  const login = await run(bin, ["login", "status"], env, cwd);
  const auth = /ChatGPT/i.test(login.out) ? "chatgpt" : /API key/i.test(login.out) ? "api_key" : /not logged in/i.test(login.out) ? "signed_out" : "unknown";
  return { ok: false, why: "codex_unsupported", version: (v.out.match(/(\d+\.\d+\.\d+)/) || [])[1] || null, auth, say: "Night Shift doesn't run on Codex yet. " + CODEX_BLOCKERS.join(" ") + " Nothing was started." };
}

// A run that ended because the plan's usage ran out: no retry, no other credential, no paid fallback.
export const USAGE_LIMIT = /usage limit|limit reached|rate[ _-]?limit|429|too many requests/i;
