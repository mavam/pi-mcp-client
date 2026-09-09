---
title: On-demand MCP resource discovery and reading
type: feature
authors:
  - mavam
prs:
  - 15
created: 2026-09-09T08:33:14.892709Z
---

Pi can now discover MCP resources alongside tools and read selected resources directly into the conversation, without a manual resource browser.

```js
mcp_tools({ query: "database schema", server: "warehouse" })
mcp_tools({ read: { server: "warehouse", uri: "schema://analytics" } })
```

Discovery searches metadata only and now defaults to both tools and resources. Set `kind: "tools"` for tool-only discovery or `kind: "resources"` for resources. Each candidate includes exact next-call arguments. Resource links returned by tools can be read without prior discovery or activation, including resources absent from the catalog.

Reads return bounded, attributed context without activating tools or making an extra attachment message. Large text and unsupported binary content use private result files. Resource catalog changes invalidate metadata without fetching content; earlier reads remain snapshots. Tool activation and native invocation are unchanged.

Resource reads go only through the configured MCP server, never through a generic URL fetch or local-file fallback. Tool-name filters do not restrict resources. Resource templates and subscriptions remain unsupported.
