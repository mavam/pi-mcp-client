The MCP status experience is now unified under a single command with a clearer, themed panel. The responsive presentation keeps server states and tool counts readable across terminal sizes while recording status snapshots without extra model or connection activity.

## 💥 Breaking changes

### Single MCP status command

The redundant `/mcp list` and `/mcp status` commands have been removed. Use `/mcp` without arguments to check server status and tool counts. Update saved commands or integrations that invoke either alias to use `/mcp` instead.

*By @mavam in #27.*

## 🔧 Changes

### Themed MCP status panel

`/mcp` now shows a themed status panel with bold server names, colored state indicators, and aligned tool counts. The layout adapts to the terminal width and uses stacked rows on narrow screens. State labels and glyphs remain readable without color.

Each invocation leaves a status snapshot in the transcript without sending it to the model or opening server connections. RPC clients continue to receive plain text.

*By @mavam in #27.*
