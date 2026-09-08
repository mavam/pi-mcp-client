---
title: Clear, nonduplicated MCP discovery errors
type: bugfix
prs:
  - 7
authors:
  - mavam
created: 2026-09-08T09:26:37.911655Z
---

MCP discovery now distinguishes unknown servers from disabled servers and provides relevant recovery steps instead of reporting a changed tool schema. For example, `mcp_tools({query: "gmail search", server: "gog"})` reports an unconfigured server when no MCP server named `gog` exists and suggests omitting `server` to search all enabled servers.

Expanded tool results no longer repeat a local error message beneath an identical status row.
