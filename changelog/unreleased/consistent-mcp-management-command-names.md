---
title: Consistent MCP management command names
type: breaking
prs:
  - 10
authors:
  - mavam
created: 2026-09-09T05:34:44.32975Z
---

MCP management now uses the same command names as Codex and Claude Code:

- Replace `/mcp auth <server>` with `/mcp login <server>`.
- Replace `/mcp inspect <server>` with `/mcp get <server>`.

The old names are no longer accepted. Authentication and redacted server
inspection otherwise behave as before.
