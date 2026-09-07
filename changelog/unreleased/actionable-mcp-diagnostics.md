---
title: Actionable MCP diagnostics
type: feature
authors:
  - mavam
created: 2026-09-07T07:48:31.811744Z
---

MCP failures now include a consistent diagnostic code, a short explanation, and an actionable recovery hint across search, tool calls, and `/mcp`:

```text
linear: [authentication_required] Authentication is required. Run /mcp auth linear.
```

Diagnostics distinguish configuration, authentication, permission, keyring, secret-command, connection, timeout, protocol, cancellation, and tool failures. Search and tool results also include structured diagnostic details with `code`, `operation`, optional `server`, `message`, and `hint`. Partial discovery keeps healthy results rather than treating unavailable servers as empty catalogs.

Raw exception messages, HTTP bodies, command stderr, and stack traces stay out of diagnostics. Server-provided tool results remain visible as content. Failed invocations are never replayed automatically, and cancelled shared work no longer produces an unhandled rejection.
