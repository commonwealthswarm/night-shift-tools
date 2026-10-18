import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SUPERVISED_TOOL_CALLS = 32;

// Launcher-owned directory, outside the model's file boundary. Exclusive ticket creation
// is atomic across concurrent PreToolUse processes. Retries consume another ticket.
export function reserveToolCall(ctl) {
  const dir = join(ctl, "tool-budget");
  if (!existsSync(dir)) return true; // ordinary runs keep their existing policy
  try {
    const { max_tool_calls: max } = JSON.parse(readFileSync(join(dir, "limit.json"), "utf8"));
    if (max !== SUPERVISED_TOOL_CALLS) return false;
    for (let i = 0; i < max; i++) {
      try { writeFileSync(join(dir, `${i}.ticket`), "", { flag: "wx", mode: 0o600 }); return true; }
      catch (e) { if (e.code !== "EEXIST") return false; }
    }
  } catch {}
  return false;
}

export function admittedToolCalls(ctl) {
  try { return readdirSync(join(ctl, "tool-budget")).filter(n => /^\d+\.ticket$/.test(n)).length; }
  catch { return null; }
}

// A response may arrive in several assistant content-block messages with the same ID.
// num_turns on a successful CLI result counts user/tool-result messages, not this metric.
export function streamCounters() {
  const responses = new Set(), toolTurns = new Set(), calls = new Set();
  let userMessages = 0, missingIds = 0;
  return {
    observe(m) {
      if (m.type === "user") userMessages++;
      if (m.type !== "assistant" || !Array.isArray(m.message?.content)) return;
      const id = m.message.id;
      if (id) responses.add(id); else missingIds++;
      for (const c of m.message.content) if (c.type === "tool_use") {
        if (id) toolTurns.add(id);
        if (c.id) calls.add(c.id);
      }
    },
    snapshot() { return { response_messages: responses.size, tool_use_turns: toolTurns.size, tool_calls_requested: calls.size, user_messages: userMessages, assistant_blocks_without_message_id: missingIds }; },
  };
}
