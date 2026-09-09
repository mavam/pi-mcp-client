---
title: User-selected MCP prompts with previews
type: feature
authors:
  - mavam
created: 2026-09-09T15:12:47.62601Z
---

You can now browse server-provided prompts, enter arguments, and review their resolved contents before sending them to the model:

```text
/mcp prompts docs
/mcp prompt docs explain topic="OAuth flows"
```

Only **Use prompt** starts a model turn. Browsing fetches metadata only, cancelling a preview leaves the conversation unchanged, and using a prompt doesn't activate tools or grant additional permissions. Text and embedded text resources are supported. Prompts with oversized or unsupported content are refused instead of being silently truncated or partially used.

The assistant can discover prompt metadata with `kind: "prompts"` and recommend a command, but prompt selection remains yours. Catalog notifications refresh metadata on the next discovery without changing previews or saved snapshots.
