This release makes MCP tool use safer and more predictable by separating discovery from explicit activation, while adding commands to enable or disable servers without editing configuration. It also improves the readability of expanded JSON results in the user interface.

## 💥 Breaking changes

### Explicit activation for discovered MCP tools

`mcp_tools` replaces `mcp_search` without backward compatibility. Calls with `{query: ...}` no longer load tools, even when the query is an exact tool name. It returns candidates with short descriptions and required parameter names. Explicitly activate the identifiers you need before calling the native tools:

```js
mcp_tools({ query: "list teams", server: "linear" })
mcp_tools({ activate: ["linear.list_teams"] })
```

First use of a capability now takes an extra step: discover, activate, then call. This prevents fuzzy search matches from becoming active tools. Activation accepts only exact identifiers, works without a prior search, and reports failures with nearby catalog names when available. Update explicit Pi tool allowlists to use `mcp_tools` and activate the tools you need again in existing sessions. Only results from `mcp_tools` restore activated tools.

Discovery rows keep tool identifiers prominent and descriptions gray, without dash separators. An empty circle marks inactive candidates; a filled circle marks tools already active when discovery runs, without a status suffix. Successful activation shows a checkmark and identifier without a redundant status suffix; failures retain their reason.

The UI labels calls **mcp discover** or **mcp activate** to distinguish the two operations.

*By @mavam in #6.*

## 🚀 Features

### MCP server enable and disable commands

You can now enable or disable MCP servers without editing JSON:

```text
/mcp disable linear
/mcp enable linear
```

The commands save the change in the server's effective global or trusted-project configuration and apply it without restarting Pi. Disabling closes the connection and deactivates the server's tools. Enabling keeps connections and tool discovery on demand. Tab completion suggests disabled servers for `enable` and enabled servers for `disable`.

*By @mavam in #5.*

### Readable JSON in expanded MCP results

Expanded MCP tool results now show JSON with indentation and syntax highlighting, making responses such as issue details easier to scan. JSON resource MIME types and structured content guide rendering; unlabeled JSON objects and arrays are detected automatically. Other formats and invalid, truncated, or oversized JSON stay plain text. Responses sent to the assistant are unchanged.

Argument-validation errors now show a compact status instead of repeating the entire error and argument payload. Expand the result to see the validation details once, followed by syntax-highlighted received arguments.

*By @mavam in #4.*
