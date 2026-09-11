---
title: Single MCP status command
type: breaking
authors:
  - mavam
prs:
  - 27
created: 2026-09-11T06:33:35.87568Z
---

The redundant `/mcp list` and `/mcp status` commands have been removed. Use `/mcp` without arguments to check server status and tool counts. Update saved commands or integrations that invoke either alias to use `/mcp` instead.
