---
title: Consistent error colors in MCP tool results
type: bugfix
authors:
  - mavam
prs:
  - 8
created: 2026-09-08T14:02:21.92906Z
---

MCP tool errors now use the error color consistently for failure messages and details, rather than blue or muted text. This applies to discovery, activation, native tool calls, and argument validation. Successful results, warnings, and JSON syntax highlighting keep their existing colors.
