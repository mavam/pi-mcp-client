---
title: Automatic OAuth for HTTP servers
type: breaking
authors:
  - mavam
prs:
  - 19
  - 20
created: 2026-09-09T12:51:16.605022Z
---

HTTP authentication is automatic: connections reuse stored OAuth tokens, handle challenges through the MCP SDK, and preserve configured Authorization headers. Login no longer changes configuration files, and only explicit login registers a client or opens a browser.

Remove the `oauth` field from server definitions and `--oauth` from commands. Both are rejected rather than retained as compatibility switches. Client IDs, scopes, and callback ports remain supported:

```text
/mcp add --scope global slack https://mcp.slack.com/mcp
/mcp login slack
```

The optional `type` field is inferred from `url` or `command`, so minimal HTTP definitions need only a URL. Public servers remain usable when the OS credential store is unavailable.

Sign in again after upgrading. OAuth credential identities now depend only on the server URL and optional client ID; earlier entries aren't migrated or deleted. Revoke old grants at the service if needed. Older session results without display metadata render as plain text instead of using a compatibility formatter.
