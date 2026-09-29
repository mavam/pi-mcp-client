---
title: Work with Pi's built-in MCP support
type: feature
authors:
  - mavam
created: 2026-09-29T17:40:28.480109Z
---

Pi 0.99 introduced built-in MCP support, and this extension keeps replacing it when installed. Pi now prints a one-time warning about that replacement; disable `mcp` under Built-in in `pi config` to silence it.

Extensions that register servers with `pi.registerMcpServer()` now connect through this extension too. Servers in `mcp.json` take precedence, and registrations are never written to disk. Tools loaded through `mcp_tools` also join an `mcp__<server>` namespace and carry the annotations that servers declare, so permission extensions can confirm only calls that change something.
