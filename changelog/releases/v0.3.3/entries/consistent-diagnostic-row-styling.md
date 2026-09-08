---
title: Consistent diagnostic row styling
type: bugfix
authors:
  - mavam
created: 2026-09-08T15:11:34.019785Z
---

Failed MCP discovery rows now match other result rows: the failure glyph and server name use the error color, while the explanation stays muted. Diagnostic explanations also omit redundant error-code prefixes and separators.
