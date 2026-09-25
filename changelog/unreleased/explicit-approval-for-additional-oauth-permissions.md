---
title: Explicit approval for additional OAuth permissions
type: feature
authors:
  - mavam
prs:
  - 32
created: 2026-09-25T12:45:41.898734Z
---

When an MCP server requires additional OAuth permissions, the operation now stops with a request to review them. Run `/mcp login example` to page through the requested scope names and approve a fresh login that retains configured and known previously granted scopes, including when subsequent token responses omit scope information.

If the previous grant's scopes are unknown, the review warns that its permissions might not be retained. Configure `oauthScopes` with the permissions you need rather than relying on unspecified service defaults. After review, sign-in dialogs show a scope count instead of repeating long permission lists.

Declining or cancelling sign-in leaves your existing grant unchanged. Reloading configuration cancels active sign-in. No browser opens until you approve, and signing in never replays the rejected operation. Scope requests expire after ten minutes and aren't saved across sessions or configuration reloads.
