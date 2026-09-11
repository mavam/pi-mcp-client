---
title: Themed MCP status panel
type: change
authors:
  - mavam
created: 2026-09-11T06:15:59.729141Z
---

`/mcp`, `/mcp list`, and `/mcp status` now show a themed status panel with bold server names, colored state indicators, and aligned tool counts. The layout adapts to the terminal width and uses stacked rows on narrow screens. State labels and glyphs remain readable without color.

Each invocation leaves a status snapshot in the transcript without sending it to the model or opening server connections. RPC clients continue to receive plain text.
