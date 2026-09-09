---
title: One command for browsing and opening prompts
type: change
authors:
  - mavam
prs:
  - 26
created: 2026-09-09T19:57:07.44625Z
---

Use `/mcp prompt <server>` to browse prompts, or add a name and arguments to open one directly:

```text
/mcp prompt docs
/mcp prompt docs explain topic="OAuth flows"
```

The separate `/mcp prompts` command has been removed. Replace existing `/mcp prompts <server>` invocations with `/mcp prompt <server>`. Preview and confirmation behavior stays the same.
