# Night Shift tools

The launcher starts Claude Code in a new restricted run folder with the Night Shift MCP tools. Copy the command from the Night Shift site; it pins one reviewed tools commit and runs `start`. Do not replace it with a plain `claude mcp add` session: that does not apply the launcher's privacy and stop controls.

## Subscription and cost

Before inference, the launcher checks the effective Claude Code authentication in the same restricted environment as the run. Only a saved `claude.ai` / `firstParty` sign-in on an eligible Pro, Max, Team or Enterprise plan passes. API keys, Console/cloud billing, token overrides, unknown plans and silent credential fallback remain blocked.

Your subscription's existing extra-usage settings are your choice. If you enabled extra usage, Night Shift may use it and incur additional charges. Night Shift does not change billing settings, enable overflow, purchase credits, or require Usage credits to be Off. A provider usage rejection ends the run without a launcher retry or a switch to another credential. This is not a zero-extra-cost guarantee.

If your CLI reports API authentication, complete the official `claude auth login --claudeai` subscription sign-in yourself. The launcher never signs in for you. A successful sign-in still has to pass the version, managed-configuration and privacy checks.

## Availability

Claude Code's local privacy and lifecycle controls were tested on macOS with Claude Code 2.1.299 using synthetic files and loopback models. Real research acceptance is separate. Codex, Gemini, chat paste and cloud routines remain unavailable. The experimental Codex context helper is not a full runner and is not used by the launcher.

Weekly participation requires an explicit choice after the first report. `schedule` writes a file for review; it never installs it. Neither a saved weekly choice nor a saved reminder preference starts a schedule or sends an email.

## Supervised local acceptance test

`start --supervised` requires a loopback `NIGHT_SHIFT_SITE` and an absolute `NIGHT_SHIFT_STATE_DIR`. The separate directory holds only the fixture identity and reports; HOME and Claude authentication stay unchanged. This mode still performs every subscription, version, managed-settings and privacy check. It uses Haiku at low effort, at most 16 turns and 120 seconds (or a shorter `NIGHT_SHIFT_LIMIT_SECONDS`), with zero configured API retries, no streaming fallback and a requested 2,048-token output limit per response. It disables browser opening, completes one small task, and refuses another check-in or weekly choice after the report. These limits are not a dollar cap; enabled subscription overflow can still cost money.
