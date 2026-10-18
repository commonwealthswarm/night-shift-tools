// EXPERIMENTAL, macOS only, not used by the launcher. Codex stays unavailable in Night Shift.
//
// Codex 0.163.0 reads the person's global AGENTS.md, AGENTS.override.md and skills from CODEX_HOME and HOME on its
// own, before any tool runs, even with its isolation options on. This helper runs Codex under a sandbox-exec file
// profile that only denies reading file contents (file-read-data) under CODEX_HOME and HOME. It keeps readable
// CODEX_HOME/auth.json (so the CLI can sign in) and installation_id and tmp/ (Codex fails to start without them once
// it has run before in that CODEX_HOME). It also moves Codex's databases and logs to a separate runtime folder,
// turns off the skill catalog, bundled skills and project docs, and requests skip_host_skill_discovery (a request
// only: on its own it didn't stop discovery in a negative control).
//
// What it was shown to do (test/codex-context.mjs, stand-in files, a synthetic API-shaped auth.json, a loopback fake
// model): a request that succeeds without those personal files in it.
// What it doesn't do: everything else is allowed by default, so it doesn't stop writes to the person's files,
// confine the network, or limit access to other credentials or tools. It wasn't tested with a real subscription
// sign-in or the Keychain, doesn't stop a run on its own, and does nothing about paid usage. It is not a runner.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const EXPERIMENTAL = true;
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

// sandbox-exec profile strings are double-quoted; refuse paths that could break out of one.
const safe = p => { if (!/^\/[^"\\\n\r]*$/.test(p)) throw new Error("unsupported path for the restriction profile: " + JSON.stringify(p)); return p; };

export function contextProfile({ codexHome, home }) {
  // Codex's own runtime files stay readable: auth.json to sign in, installation_id, and tmp/ (Codex fails to start
  // if it can't clean up its earlier temp folders there). Those are Codex state, not the person's instructions.
  return `(version 1) (allow default) (deny file-read-data (subpath "${safe(codexHome)}") (subpath "${safe(home)}")) (allow file-read-data (literal "${safe(join(codexHome, "auth.json"))}") (literal "${safe(join(codexHome, "installation_id"))}") (subpath "${safe(join(codexHome, "tmp"))}"))`;
}

const DISABLED = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "in_app_browser", "view_image", "hooks", "skill_search", "goals", "multi_agent", "shell_snapshot"];

export function contextArgs({ work, runtime }) {
  return ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-C", work, "--sandbox", "read-only",
    ...DISABLED.flatMap(f => ["--disable", f]), "--enable", "skip_host_skill_discovery",
    "-c", `sqlite_home="${safe(runtime)}"`, "-c", `log_dir="${safe(runtime)}"`,
    "-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false", "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"'];
}

// Runs `bin args` under the profile. The profile file and runtime folder go in `scratch`, which the caller owns.
export function runRestricted(bin, args, { codexHome, home, cwd, env, scratch, timeoutMs = 90_000 }) {
  if (process.platform !== "darwin") return Promise.resolve({ code: null, unsupported: true, out: "", err: "" });
  mkdirSync(scratch, { recursive: true });
  const profile = join(scratch, "restriction.sb");
  writeFileSync(profile, contextProfile({ codexHome, home }), { mode: 0o600 });
  return new Promise(r => {
    const p = spawn(SANDBOX_EXEC, ["-f", profile, bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("exit", (code, signal) => { clearTimeout(t); r({ code, signal, out, err }); });
    p.on("error", e => { clearTimeout(t); r({ code: 127, out, err: String(e) }); });
  });
}
