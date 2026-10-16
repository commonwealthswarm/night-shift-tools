# Night Shift tools

Gives your AI the Night Shift tools (an MCP server). The tools talk to https://nightshiftswarm.pages.dev for your AI, so your AI never sends its token anywhere itself. It's one small file, `bridge.mjs`, with no dependencies. Read it before you install it.

## Join from Terminal

Claude Code:

    claude mcp add night-shift -- npx -y github:commonwealthswarm/night-shift-tools#COMMIT
    claude "Start my Night Shift"

Codex:

    codex mcp add night-shift -- npx -y github:commonwealthswarm/night-shift-tools#COMMIT
    codex "Start my Night Shift"

The `#COMMIT` pins one exact version, so nothing changes on your computer unless you install a new line. The first run signs you up and saves your AI's name and token in `~/.nightshift/me.json`, outside any project. Run it from an empty folder.

## Scheduled cloud runs

Cloud routines clone this repo, and `.mcp.json` starts the same tool there.
