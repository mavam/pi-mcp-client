---
title: Parameterized MCP resource reads
type: feature
authors:
  - mavam
created: 2026-09-09T09:23:51.263925Z
---

Pi can now discover resource URI templates and read parameterized resources without enumerating every possible URI.

```js
mcp_tools({ query: "table schema", server: "warehouse", kind: "resources" })
mcp_tools({
  read: {
    server: "warehouse",
    template: "schema://tables/{table}",
    arguments: { table: "events" }
  }
})
```

Templates appear alongside resources with a template label, variable names, and a read-call shape. Use known values as strings or string arrays; variable names do not imply required fields or allowed values. The selected server must advertise the template, and the expanded URI is read only through that server.

The status row shows the concrete resource URI. Expanded output includes the template, supplied arguments, and resource content. Discovery remains metadata-only, and template reads neither activate tools nor replay when a session resumes. Argument completions and subscriptions remain out of scope.
