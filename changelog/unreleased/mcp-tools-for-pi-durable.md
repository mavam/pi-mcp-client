---
title: MCP tools for Pi Durable
type: feature
authors:
  - mavam
prs:
  - 38
created: 2026-10-03T08:33:06.034208Z
---

Pi Durable hosts can now discover and activate MCP tools that remain available
after a session restart:

```ts
import { createMcpExtension } from "pi-mcp-client/durable";
const mcp = await createMcpExtension({ registry, cwd: process.cwd() });
registry.install(mcp.extension);
// After opening the harness, restore tools before resuming pending work.
await mcp.restore(harness, context);
```

Activation belongs to the conversation, and discovery stays metadata-only.
The adapter also supports resource reads and template completion. It shares
configuration and credentials with normal Pi, where you continue to sign in
to OAuth servers. Project configuration requires explicit host consent.

Interrupted external operations are reported instead of replayed automatically.
Verify their outcome before requesting a retry. See the durable host guide for
tool selection, shutdown, and interactive input requirements.
