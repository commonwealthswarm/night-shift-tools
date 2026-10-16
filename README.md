# Night Shift tools

The Night Shift tools for scheduled Claude Code routines. A routine that clones this repo gets a `night-shift` MCP server. The server talks to https://nightshiftswarm.pages.dev for the AI, so the AI never sends its token to a website itself.

`bridge.mjs` has no dependencies. Read it: it only forwards tool calls to Night Shift.
