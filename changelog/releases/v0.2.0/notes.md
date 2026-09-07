Pi now makes MCP servers easier to understand and manage without restarting: inspect server status and configuration, browse tool signatures, reload configuration safely, and discover catalog changes as they happen. Compact command completion keeps the /mcp menu focused while preserving access to every configured server.

## 🚀 Features

### MCP server inspection, tool browsing, and reload

You can now inspect MCP servers, browse their tools, and apply configuration changes without restarting Pi:

- `/mcp list` (also `/mcp` or `/mcp status`) shows a compact status matrix with state glyphs and per-server catalog and loaded-tool counts. Filled circles (`●`) mark connected servers; hollow circles (`○`) mark idle or disabled servers, distinguished by their state labels. Idle servers connect on demand; a dash marks catalogs not fetched yet.
- `/mcp inspect <server>` shows the server's status and configuration, including disabled servers. Connection values stay hidden to protect credentials.
- `/mcp tools <server>` opens a list of tool names and descriptions trimmed to your terminal width. Select a tool to see its signature with one argument per line, followed by the tool description and a separate paragraph for each parameter. Browsing doesn't make tools active for the assistant.
- `/mcp reload` applies changes from your MCP configuration files. Invalid configuration leaves your current setup intact. Existing connections close and reopen on demand; tools from changed, removed, or disabled server definitions are deactivated, while unchanged active tools remain available.

Tool browsing respects your configured tool filters and requires an interactive UI.

*By @mavam in #2.*

### Tool catalog change notifications

Pi now notices when a connected MCP server adds, removes, or changes its tools and refreshes its catalog the next time the assistant searches for tools. Previously, searches could miss newly added tools or keep showing tools that were no longer available.

Tools already in use aren't silently changed. If a server changes a tool's expected inputs, calls using the old definition are blocked until the assistant discovers the updated tool.

*By @mavam in #1.*

## 🐞 Bug fixes

### Compact MCP command completion

The `/mcp` autocomplete menu no longer expands every command into every configured server. It first shows only subcommands, such as `tools` and `inspect`. After you enter a subcommand followed by a space, it shows matching server names.

This keeps the initial menu short and avoids scrolling through repeated command-and-server combinations. Disabled servers remain available for inspection but aren't suggested for commands that require an enabled server.

*By @mavam in #3.*
