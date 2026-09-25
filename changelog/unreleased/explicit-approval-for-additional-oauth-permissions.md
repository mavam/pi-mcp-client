---
title: Explicit approval for additional OAuth permissions
type: feature
authors:
  - mavam
prs:
  - 32
created: 2026-09-25T11:36:04.204109Z
---

When an MCP server requires additional OAuth permissions, the operation now stops with a request to review them. Run `/mcp login example` to page through the requested scope names and approve a fresh login that retains configured and previously granted scopes, including when token responses omit scope information.

Declining or cancelling sign-in leaves your existing grant unchanged. Reloading configuration cancels active sign-in. No browser opens until you approve, and signing in never replays the rejected operation. Scope requests expire after ten minutes and aren't saved across sessions or configuration reloads.
