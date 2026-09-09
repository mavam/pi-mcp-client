---
title: Previewable JSON configuration imports
type: feature
authors:
  - mavam
prs:
  - 25
created: 2026-09-09T16:54:01.76736Z
---

You can now import server definitions from a local Claude/Cursor-style JSON file instead of adding each connection by hand:

```text
/mcp import --scope project "/path/to/mcp.json"
```

Review each server with connection values hidden, skip unsupported entries, and explicitly choose replacements or new names for conflicts. A final confirmation explains that inline credentials are copied with the selected definitions. The import saves all selected servers together without connecting, executing commands, or accessing another client's credential store. If the destination configuration changes during review, the import refuses to overwrite it.

Imports require an interactive TUI or RPC session. The initial format is a top-level `mcpServers` object with stdio or Streamable HTTP connections; other formats and client-specific options aren't silently translated.
