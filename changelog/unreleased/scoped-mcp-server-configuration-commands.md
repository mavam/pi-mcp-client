---
title: Scoped MCP server configuration commands
type: feature
authors:
  - mavam
prs:
  - 13
created: 2026-09-09T06:09:12.475758Z
---

You can now add and remove MCP servers without editing JSON. Both commands require
an explicit global or project scope:

```text
/mcp add --scope global docs https://docs.mcp.cloudflare.com/mcp
/mcp add --scope project local -- node "/path with spaces/server.js"
/mcp remove --scope project local
```

Adding validates and saves the definition without starting a server, running secret
commands, authenticating, or activating tools. Use `--replace` to replace an
existing definition in the selected scope. Headers, environment overrides, and
OAuth options are supported; put options before the server name.

Removal retains credentials and reports when a definition from the other scope
remains effective. Changed or removed effective definitions lose their active
tools. Project edits require a trusted project, and unrelated settings are
preserved. Changes apply immediately in the current Pi session.
