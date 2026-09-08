---
title: MCP server enable and disable commands
type: feature
authors:
  - mavam
created: 2026-09-08T08:14:18.651705Z
---

You can now enable or disable MCP servers without editing JSON:

```text
/mcp disable linear
/mcp enable linear
```

The commands save the change in the server's effective global or trusted-project configuration and apply it without restarting Pi. Disabling closes the connection and deactivates the server's tools. Enabling keeps connections and tool discovery on demand. Tab completion suggests disabled servers for `enable` and enabled servers for `disable`.
