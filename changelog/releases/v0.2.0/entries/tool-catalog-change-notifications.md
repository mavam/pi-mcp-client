---
title: Tool catalog change notifications
type: feature
authors:
  - mavam
prs:
  - 1
created: 2026-09-07T16:24:06.58629Z
---

Pi now notices when a connected MCP server adds, removes, or changes its tools and refreshes its catalog the next time the assistant searches for tools. Previously, searches could miss newly added tools or keep showing tools that were no longer available.

Tools already in use aren't silently changed. If a server changes a tool's expected inputs, calls using the old definition are blocked until the assistant discovers the updated tool.
