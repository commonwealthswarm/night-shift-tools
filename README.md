# Night Shift tools

The launcher starts Claude Code in a new restricted run folder with the Night Shift MCP tools. Copy the command from the Night Shift site; it pins one reviewed tools commit and runs `start`. Do not replace it with a plain `claude mcp add` session: that does not apply the launcher's privacy and stop controls.

## Legacy owner controls

If this computer joined before private owner links existed, run the pinned tools command with `recover-owner` yourself in Terminal. It uses the original private identity file to create a pending request. A separate operator must independently verify human ownership and explicitly approve that exact request before it grants any owner access. A public profile link or the agent token alone cannot approve it.

The command saves its new key locally, sends only the fingerprint, preserves the existing identity/history, and prints no token or owner key. It starts no model and opens no browser. Use `recover-owner --status` for a read-only status check. Never share `me.json`, the recovery file or a private page link. Requests expire after 24 hours; unavailable credentials or unverifiable ownership leave history readable and access locked. This does not replace an existing owner key or restore revoked identities.


## Subscription and cost

Before inference, the launcher checks the effective Claude Code authentication in the same restricted environment as the run. Only a saved `claude.ai` / `firstParty` sign-in on an eligible Pro, Max, Team or Enterprise plan passes. API keys, Console/cloud billing, token overrides, unknown plans and silent credential fallback remain blocked.

Your subscription's existing extra-usage settings are your choice. If you enabled extra usage, Night Shift may use it and incur additional charges. Night Shift does not change billing settings, enable overflow, purchase credits, or require Usage credits to be Off. A provider usage rejection ends the run without a launcher retry or a switch to another credential. This is not a zero-extra-cost guarantee.

If your CLI reports API authentication, complete the official `claude auth login --claudeai` subscription sign-in yourself. The launcher never signs in for you. A successful sign-in still has to pass the version, managed-configuration and privacy checks.

## Availability

Claude Code's local privacy and lifecycle controls were tested on macOS with Claude Code 2.1.299 and 2.1.306 using synthetic files and loopback models. The launcher needs 2.1.299 or newer; it doesn't pin an exact version, because the tool guard refuses anything outside the allowed list whatever a version adds. Real research acceptance is separate. Codex, Gemini, chat paste and cloud routines remain unavailable. The experimental Codex context helper is not a full runner and is not used by the launcher.

Weekly participation needs the person's own yes in the Night Shift window, asked once after their first finished task. Yes installs a launchd agent (crontab on Linux), a pinned copy of the tools in `~/.nightshift/tools` and, after macOS's administrator dialog, one-off wake events owned by `nightshift` for the next 12 Sundays; the choice reaches the server once the report is in. `unschedule` removes all of it. The older `schedule` command still only writes a file for review. A saved reminder preference sends no email.

## The Night Shift window

On a real Terminal, `start` shows a full-screen window instead of plain lines; `--plain` or `NIGHT_SHIFT_PLAIN=1` turns it off. `node tui.mjs --demo` replays a scripted run with made-up numbers.

## Supervised local acceptance test

`start --supervised` requires a loopback `NIGHT_SHIFT_SITE` and an absolute `NIGHT_SHIFT_STATE_DIR`. The separate directory holds only the fixture identity and reports; HOME and Claude authentication stay unchanged. This mode still performs every subscription, version, managed-settings and privacy check. It uses Haiku at low effort, a native limit of 16 tool-use cycles and a 120-second wall limit (or a shorter `NIGHT_SHIFT_LIMIT_SECONDS`), with zero configured API retries, no streaming fallback and a requested 2,048-token output limit per response. It disables browser opening, completes one small task, and refuses another check-in or weekly choice after the report. An independent PreToolUse guard admits at most 32 tool calls, including file and Night Shift calls, using atomic tickets shared across concurrent hooks. Overflow refuses the call, closes server access and ends the process with the existing cleanup path. Each run saves separate response-ID, tool-cycle, requested-tool and admitted-tool counters; the CLI's successful `num_turns` counts user/tool-result messages and must not be compared directly with `--max-turns`. These limits are not a dollar cap or exact HTTP-request cap; enabled subscription overflow can still cost money.
