---
title: MCP logout and authentication status
type: feature
authors:
  - mavam
prs:
  - 11
created: 2026-09-09T05:41:54.487248Z
---

You can now remove stored MCP OAuth credentials with `/mcp logout <server>`,
including for disabled servers. Logout closes related connections and deactivates
their tools, but preserves configuration and enabled state. Header and
server-managed credentials remain untouched.

Logout reports local removal separately from best-effort remote token revocation.
When revocation cannot be confirmed, revoke access at the service if needed.

Use `/mcp get <server>` to see the authentication method and whether OAuth tokens
are stored. Inspection never validates tokens online or exposes their values.
