MCP discovery now reports unknown and disabled servers with relevant recovery steps. Expanded tool results show local error messages only once.

## 🐞 Bug fixes

### Clear, nonduplicated MCP discovery errors

MCP discovery now distinguishes unknown servers from disabled servers and provides relevant recovery steps instead of reporting a changed tool schema. For example, `mcp_tools({query: "gmail search", server: "gog"})` reports an unconfigured server when no MCP server named `gog` exists and suggests omitting `server` to search all enabled servers.

Expanded tool results no longer repeat a local error message beneath an identical status row.

*By @mavam in #7.*
