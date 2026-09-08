---
title: Explicit activation for discovered MCP tools
type: breaking
authors:
  - mavam
prs:
  - 6
created: 2026-09-08T08:45:33.15131Z
---

`mcp_tools` replaces `mcp_search` without backward compatibility. Calls with `{query: ...}` no longer load tools, even when the query is an exact tool name. It returns candidates with short descriptions and required parameter names. Explicitly activate the identifiers you need before calling the native tools:

```js
mcp_tools({ query: "list teams", server: "linear" })
mcp_tools({ activate: ["linear.list_teams"] })
```

First use of a capability now takes an extra step: discover, activate, then call. This prevents fuzzy search matches from becoming active tools. Activation accepts only exact identifiers, works without a prior search, and reports failures with nearby catalog names when available. Update explicit Pi tool allowlists to use `mcp_tools` and activate the tools you need again in existing sessions. Only results from `mcp_tools` restore activated tools.

Discovery rows keep tool identifiers prominent and descriptions gray, without dash separators. An empty circle marks inactive candidates; a filled circle marks tools already active when discovery runs, without a status suffix. Successful activation shows a checkmark and identifier without a redundant status suffix; failures retain their reason.

The UI labels calls **mcp discover** or **mcp activate** to distinguish the two operations.
