---
title: Separate OAuth logins for named servers
type: breaking
authors:
  - mavam
prs:
  - 23
created: 2026-09-09T14:35:33.540985Z
---

Each named MCP server now has its own OAuth login, even when multiple servers use the same URL and client ID. You can keep personal and work accounts connected at the same time by giving them different server names:

```text
/mcp login cloudflare-personal
/mcp login cloudflare-work
```

Logging out removes only the selected named connection's local credentials and deactivates only its tools. Remote revocation behavior still depends on the service.

After upgrading, run `/mcp login <server>` again for each OAuth connection. Earlier credentials aren't migrated or deleted. Renaming a server also requires a new login; log out before renaming if you want to remove its old credentials. Definitions with the same name, URL, and client ID continue to share credentials across projects.
