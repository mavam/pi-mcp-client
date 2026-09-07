---
title: MCP server inspection, tool browsing, and reload
type: feature
authors:
  - mavam
prs:
  - 2
created: 2026-09-07T16:38:01.824126Z
---

You can now inspect MCP servers, browse their tools, and apply configuration changes without restarting Pi:

- `/mcp list` (also `/mcp` or `/mcp status`) shows a compact status matrix with state glyphs and per-server catalog and loaded-tool counts. Idle servers connect on demand; a dash marks catalogs not fetched yet.
- `/mcp inspect <server>` shows the server's status and configuration, including disabled servers. Connection values stay hidden to protect credentials.
- `/mcp tools <server>` opens a scrollable list of the server's tools. Select a tool to read its description without making it active for the assistant.
- `/mcp reload` applies changes from your MCP configuration files. Invalid configuration leaves your current setup intact. Existing connections close and reopen on demand; tools from changed, removed, or disabled server definitions are deactivated, while unchanged active tools remain available.

Tool browsing respects your configured tool filters and requires an interactive UI.
