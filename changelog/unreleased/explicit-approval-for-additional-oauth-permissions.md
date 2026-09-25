---
title: Explicit approval for additional OAuth permissions
type: feature
authors:
  - mavam
created: 2026-09-25T11:25:43.355712Z
---

When an MCP server requires additional OAuth permissions, the operation now stops with a request to review them. Run `/mcp login example` to inspect the requested scope names and approve a fresh login that retains configured and previously granted scopes.

Declining leaves your existing grant unchanged. No browser opens until you approve, and signing in never replays the rejected operation. Requests expire after ten minutes and aren't saved across sessions or configuration reloads.
