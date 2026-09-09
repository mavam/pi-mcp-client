---
title: Previewable configuration imports
type: feature
authors:
  - mavam
prs:
  - 25
created: 2026-09-09T17:23:06.214256Z
---

You can now import server definitions directly from Claude/Cursor JSON or Codex TOML instead of converting files or adding each connection by hand:

```text
/mcp import --scope global ~/.claude.json
/mcp import --scope global ~/.codex/config.toml
/mcp import --scope project "/path/to/mcp.json"
```

Claude files with project-specific servers offer a source-group chooser. Codex imports preserve disabled state, environment references, tool filters, and separate startup and tool-call timeouts, including Codex's defaults.

Review each server with connection values hidden, skip unsupported entries, and explicitly choose replacements or new names for conflicts. A final confirmation explains that inline credentials are copied with the selected definitions. The import saves all selected servers together without connecting, executing commands, or accessing another client's credential store. If the destination configuration changes during review, the import refuses to overwrite it.

Imports require an interactive TUI or RPC session and support stdio and Streamable HTTP connections. Unsupported connection options and approval policies are refused rather than silently discarded.
