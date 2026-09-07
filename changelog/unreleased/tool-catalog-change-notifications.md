---
title: Tool catalog change notifications
type: feature
authors:
  - mavam
created: 2026-09-07T15:58:51.840874Z
---

Search now refreshes the tool catalog after a connected MCP server reports a change, so newly added tools become discoverable and removed tools no longer appear in search results.

Notifications don't silently replace active tool definitions. If a tool's schema changes, run `mcp_search` again to load its current definition before calling it. Cache-only searches without a live connection still use the existing 24-hour expiry.
