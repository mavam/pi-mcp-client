---
title: Skip invalid servers instead of failing the whole file
type: change
authors:
  - mavam
created: 2026-09-29T18:16:12.784172Z
---

One invalid server no longer breaks the rest of your configuration. Invalid entries, such as an unknown field, an unsupported OAuth option, or a name this extension doesn't accept, are now skipped with a warning that names the server and the field. The other servers in the file still load, as in Pi's built-in MCP support. Files that share definitions with that support, for example through `pi mcp add`, no longer disable all your servers when one entry uses an option only the built-in extension understands. A file that isn't valid JSON, or that lacks an `mcpServers` object, still fails as a whole.
