---
title: Resource argument completions and explicit subscriptions
type: feature
authors:
  - mavam
prs:
  - 17
created: 2026-09-09T10:16:25.834578Z
---

Pi can now request server-provided resource argument suggestions and explicitly watch resource changes without replacing attached snapshots.

Complete a template variable with a prefix, or an empty string to request initial suggestions:

```js
mcp_tools({
  complete: {
    server: "warehouse",
    template: "schema://tables/{table}",
    argument: { name: "table", value: "ev" }
  }
})
```

Completions can include known argument values for dependent suggestions. They never read resources or activate tools, and their output follows the existing size limits.

Use `/mcp subscribe warehouse schema://tables/events` to watch a resource,
`/mcp subscriptions` to inspect watches, and `/mcp unsubscribe warehouse schema://tables/events` to stop watching. Updates show a change marker and a UI notification without fetching content or starting a model turn. Repeated updates coalesce until you unsubscribe.

Subscriptions require an interactive UI and support both legacy and modern servers. Watches are limited to 50 per server connection, stay in memory, and clear on branch or session changes, configuration reload, disconnection, and exit. They never resume automatically.
