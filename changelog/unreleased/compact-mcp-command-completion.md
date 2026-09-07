---
title: Compact MCP command completion
type: bugfix
authors:
  - mavam
prs:
  - 3
created: 2026-09-07T17:01:31.336248Z
---

The `/mcp` autocomplete menu no longer expands every command into every configured server. It first shows only subcommands, such as `tools` and `inspect`. After you enter a subcommand followed by a space, it shows matching server names.

This keeps the initial menu short and avoids scrolling through repeated command-and-server combinations. Disabled servers remain available for inspection but aren't suggested for commands that require an enabled server.
