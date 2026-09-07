Pi MCP Client connects Pi to local and remote MCP servers, discovering tools on demand and calling them natively. Authenticate with OAuth or your existing credentials, and keep discovered tools available as your conversation continues.

## 🚀 Features

### Actionable MCP diagnostics

MCP failures now include a consistent diagnostic code, a short explanation, and an actionable recovery hint across search, tool calls, and `/mcp`:

```text
linear: [authentication_required] Authentication is required. Run /mcp auth linear.
```

Diagnostics distinguish configuration, authentication, permission, keyring, secret-command, connection, timeout, protocol, cancellation, and tool failures. Search and tool results also include structured diagnostic details with `code`, `operation`, optional `server`, `message`, and `hint`. Partial discovery keeps healthy results rather than treating unavailable servers as empty catalogs.

Raw exception messages, HTTP bodies, command stderr, and stack traces stay out of diagnostics. Server-provided tool results remain visible as content. Failed invocations are never replayed automatically, and cancelled shared work no longer produces an unhandled rejection.

*By @mavam.*

### Introducing Pi MCP Client

Pi MCP Client brings Model Context Protocol (MCP) tools to Pi, with on-demand discovery and native tool calls instead of an invocation proxy. Connect your existing MCP servers to give Pi access to documentation, issue trackers, and other services without loading every tool schema upfront.

Search uses BM25-based ranking to account for term rarity and description length, with stronger weighting for tool names and support for prefix matching. Exact tool selectors bypass ranking. Search parameters describe the supported limit of 1–50 tools (default: 5) and encourage focused queries. Search results display each tool once with a short `server.tool` name; expanding adds a one-line description without repeating the model-facing response. Warnings and failures remain visible. Running indicators use a muted color, reserving warning colors for actual problems.

Pi discovers the tools it needs as you work. Use `mcp_search({ query: "search issues", server: "linear" })` to load matching tools; they remain available as the conversation continues and are restored when you resume or navigate branches.

Connect local stdio servers or remote Streamable HTTP servers, authenticate with bearer headers or `/mcp auth <server>`, and inspect progress through compact status glyphs. Server filters control which tools can be loaded, and large results are saved to private temporary files.

Configure connections in `~/.pi/agent/mcp.json` using the common `mcpServers` format. Explicit `type: "stdio"` and `type: "http"` tags are supported; omit `type` to infer it from `command` or `url`. Protocol-version negotiation is automatic by default; set `"protocol": "legacy"` only when a server needs an explicit legacy handshake. Put Pi-specific options directly in each server definition, for example:

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": true,
      "includeTools": ["search_*"]
    }
  }
}
```

*By @mavam.*

### Shell command lookup for MCP secrets

You can now load MCP credentials from a password manager or another shell command instead of storing secrets in your configuration. Prefix an HTTP header or stdio environment value with `!`, for example:

```json
"env": {
  "API_TOKEN": "!op read 'op://Private/Example/token'"
}
```

Commands run when connecting, including reconnections, but not during configuration loading, status display, or cached discovery. Execution is time-limited and output-limited; failed commands stop the connection without disclosing command text or output. Resolved secrets are not stored in session records or catalog caches.

These fields also support Pi-style `$VAR` interpolation, `$$` for a literal dollar sign, and `$!` for a literal bang. Only a leading `!` in the original configuration triggers execution.

*By @mavam.*
