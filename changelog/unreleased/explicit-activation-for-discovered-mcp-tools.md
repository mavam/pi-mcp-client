---
title: Explicit activation for discovered MCP tools
type: breaking
authors:
  - mavam
created: 2026-09-08T08:25:49.621698Z
---

`mcp_search({query: ...})` no longer loads tools, even when the query is an exact tool name. It returns candidates with short descriptions and required parameter names. Explicitly activate the identifiers you need before calling the native tools:

```js
mcp_search({ query: "list teams", server: "linear" })
mcp_search({ activate: ["linear.list_teams"] })
```

First use of a capability now takes an extra step: discover, activate, then call. This prevents fuzzy search matches from becoming active tools. Activation accepts only exact identifiers, works without a prior search, and reports failures with nearby catalog names when available. Tools already loaded remain available, including those restored from older sessions.
