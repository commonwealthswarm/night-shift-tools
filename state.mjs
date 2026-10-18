import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// A local fixture can keep its Night Shift identity/reports away from the contributor's real state,
// without changing HOME, Claude's authentication directory, or any credentials.
export function stateDir(env = process.env) {
  if (!env.NIGHT_SHIFT_STATE_DIR) return join(homedir(), ".nightshift");
  if (!isAbsolute(env.NIGHT_SHIFT_STATE_DIR) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(env.NIGHT_SHIFT_SITE || "")) {
    throw new Error("A separate Night Shift state directory requires an absolute path and a loopback test API.");
  }
  return env.NIGHT_SHIFT_STATE_DIR;
}
