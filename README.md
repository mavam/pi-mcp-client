# 🔌 Pi MCP Client

MCP tools for Pi, discovered on demand and called natively through the official
TypeScript SDK. No bridge process and no invocation proxy.

## 🚀 Installation

```sh
pi install npm:pi-mcp-client
```

## ✨ Usage

First, add a server to `~/.pi/agent/mcp.json`. This public documentation server
does not require credentials:

```json
{
  "mcpServers": {
    "cloudflare-docs": {
      "type": "http",
      "url": "https://docs.mcp.cloudflare.com/mcp"
    }
  }
}
```

Start a new Pi session and ask it to search Cloudflare's documentation. Use `/mcp`
to inspect the connection. For authenticated services, see [OAuth](#oauth) or
[secret commands](#secret-commands).

Pi discovers candidates, explicitly activates the tools it needs, then calls
those tools natively. One `mcp_tools` tool supports both steps:

```js
// Discover candidates. Never activates, even for an exact-name query.
mcp_tools({ query: "list teams", server: "linear", limit: 5 })

// Activate exact identifiers. Never invokes.
mcp_tools({ activate: ["linear.list_teams", "linear.get_team"] })
```

Pass exactly one of `query` or `activate`. The optional `server` and `limit`
fields are valid only with `query`. Discovery returns up to five candidates by
default, or up to 50 with `limit`. Each candidate shows its exact activation
identifier, a short description, required parameter names only, and `[loaded]`
if already active. Results use local BM25-based ranking, with tool names weighted
more strongly than descriptions and support for prefix matching.

Activation accepts 1–50 exact `server.tool` or `mcp__server__tool` identifiers,
ignores duplicates, and works without a prior search. Typos never activate fuzzy
matches: failures list nearby catalog names when available so the assistant can
retry with an exact identifier. Each identifier reports `loaded`, `already loaded`,
or `not loaded` with a reason. Partial success keeps the tools that loaded.

Full schemas become available on the model turn after activation. First use of a
capability now takes three turns—discover, activate, call—so a fuzzy search match
can never become an active tool. Previously loaded tools remain available.

`mcp_tools` replaces `mcp_search` without backward compatibility. Update explicit
Pi tool allowlists to use `mcp_tools` and activate the tools you need again in
existing sessions. The UI labels discovery calls **mcp discover** and activation
calls **mcp activate**.

### Result display

Discovery rows show `○` for inactive candidates and `●` for already active tools,
without a status suffix. These reflect the state when discovery runs; earlier
results don't update retroactively. Activation results use `✔︎` for success and
`✘︎` for failure. Descriptions stay gray; identifiers remain prominent.

Expand a tool result to see JSON objects and arrays formatted with two-space
indentation and syntax highlighting. Explicit JSON resource MIME types (including
`application/*+json`) and structured content identify JSON without guessing.
Other explicit MIME types stay plain text; unlabeled text is checked for JSON.

Formatting changes only the display, not the response sent to the assistant.
Invalid or truncated JSON stays plain text. Results that would exceed formatting
limits also stay plain text. Resource-link MIME types describe the linked content,
not the displayed link label.

### Session behavior

- Tools accumulate rather than rotating with each prompt.
- Resume and branch navigation restore tools activated through `mcp_tools` on
  the selected branch. Discovery results never restore tools.
- Compaction retains the acquired tool set. New sessions start fresh.
- Pi uses native deferred loading where supported by the model and provider.
  Other providers receive the expanded tool list normally.
- Discovery respects server filters; activation also respects Pi's tool exclusions. An explicit tool
  allowlist must include both `mcp_tools` and the native tools you want to load.

### Commands

| Command | Purpose |
| --- | --- |
| `/mcp`, `/mcp list`, `/mcp status` | Show a server status matrix with catalog and loaded-tool counts. |
| `/mcp get <server>` | Inspect status and configuration, including disabled servers. Connection values are hidden. |
| `/mcp tools <server>` | Browse the server's tools and inspect descriptions without activating tools. |
| `/mcp reload` | Apply configuration changes without restarting Pi. |
| `/mcp enable <server>` | Enable a server in its effective configuration file. |
| `/mcp disable <server>` | Disable a server, close its connection, and deactivate its tools. |
| `/mcp login <server>` | Authenticate an OAuth-enabled HTTP server. |
| `/mcp reconnect <server>` | Replace a connection and refresh its catalog. |
| `/mcp refresh <server>` | Refresh a server's catalog without loading additional tools. |

The status matrix uses glyphs to distinguish idle (`○`), connected (`●`),
connecting (`▶︎`), disabled (`○`), and failed (`✘︎`) servers. Idle is normal:
connections open on demand. A dash (`—`) means the catalog hasn't been fetched,
not that the server has no tools. The **Loaded** column counts tools currently
active for the assistant.

After refreshing a changed schema, activate the tool again with its exact
identifier to load its current definition. Calls validate the live catalog before execution and refuse removed
or changed tools. The extension does not retry failed tool invocations; after an
interrupted call, check whether the operation completed before trying again.

## ⚙️ Configuration

Add connections to `~/.pi/agent/mcp.json`, or `.mcp.json` in a trusted project.
These files use the common Claude/Cursor-style `mcpServers` format, not a universal
MCP configuration standard. VS Code's `servers` format and Codex's TOML format
are not supported.

`PI_CODING_AGENT_DIR` overrides the global Pi directory. Project connections
replace same-named global connections in full; connection fields are not merged.

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      }
    },
    "local": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}"
      }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `type` | Optional `stdio` or `http`. If omitted, inferred from `command` or `url`. A conflicting type is rejected. |
| `command`, `args` | Executable and arguments for a stdio server. No shell is used. |
| `cwd` | Working directory for stdio; defaults to Pi's current directory. Relative paths resolve there. |
| `env` | Additional environment variables for stdio. |
| `url` | Streamable HTTP endpoint; mutually exclusive with `command`. |
| `headers` | HTTP request headers, including optional bearer authentication. |

Strings in `command`, `args`, `cwd`, `env`, `url`, and `headers` support `${VAR}`
interpolation. Missing variables prevent that server from connecting.

Only stdio and Streamable HTTP are supported; `type: "sse"` is rejected rather
than treated as HTTP. Unsupported connection fields cause a configuration error
rather than silently changing their meaning.

### Secret commands

In **`headers` and stdio `env` values only**, a leading `!` runs a secret-generating
shell command when the server connects:

```json
{
  "mcpServers": {
    "example": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "!token=$(op read 'op://Private/Example/token') && printf 'Bearer %s' \"$token\""
      }
    }
  }
}
```

These two fields also support Pi-style `$VAR` interpolation, `$$` for a literal
`$`, and `$!` for a literal `!`. Only a leading `!` in the original configuration
triggers execution; interpolated values and command output never do. Shell
commands handle their own variable expansion.

Commands use `/bin/sh` on Unix or Pi's shell selection on Windows, inherit Pi's
process environment, and run in the server's configured `cwd` (the project
directory by default). They run once per connection, including reconnections,
not during configuration loading, status display, or cached discovery. Cold
searches and activations can connect and therefore execute commands. Concurrent connection
requests share the same resolution.

The client trims stdout and rejects empty output, nonzero exits, output above
64 KiB, and resolution taking more than 10 seconds (or a shorter `timeoutMs`).
Session shutdown cancels pending commands. Cancelling an individual search or activation stops
waiting but leaves shared connection work running for other callers. The client
discards command stderr and does not include resolved secrets in errors, session
records, or catalog caches. Commands themselves remain responsible for avoiding
side effects or writing secrets to disk. Only configure commands you trust;
project configuration still requires project trust.

### Pi-specific options

Put descriptions, authentication choices, filters, and timeouts directly in each
`mcpServers.<server>` definition in `~/.pi/agent/mcp.json` (or a trusted project's
`.mcp.json`):

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "description": "Search product documentation",
      "oauth": true,
      "includeTools": ["get_*", "search_*"]
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `description` | Short capability description for Pi's server directory. |
| `oauth` | Set to `true` to use OAuth instead of an Authorization header on an HTTP connection. |
| `disabled` | Prevent this server from connecting or exposing tools. |
| `includeTools` | Optional allowlist of original MCP tool names; `*` matches any sequence. An empty list exposes nothing. |
| `excludeTools` | Denylist applied after `includeTools`. |
| `timeoutMs` | Request timeout, from 100 to 600000 ms. Defaults: 15 seconds for discovery/HTTP requests, 30 seconds for stdio tool calls. |
| `protocol` | `auto` (default) for SDK protocol-version negotiation, or `legacy` for an explicit legacy handshake. |

A trusted project's server definition replaces the same-named global definition
in full, including these options. Fields and tool-filter lists are not merged.
Every definition must include a `url` or `command`, even when `disabled` is true.

These options are specific to Pi MCP Client, not standardized MCP connection
fields. Other clients may reject them when you copy a definition.

After editing your configuration, run `/mcp reload` to apply it without restarting
Pi. Reload validates the new configuration before replacing the current setup;
invalid configuration leaves the previous setup intact. It closes existing
connections, which reopen on demand, and deactivates tools from changed, removed,
or disabled server definitions. Unchanged active tools remain available.

To toggle a server without editing JSON, use `/mcp disable <server>` or
`/mcp enable <server>`. The change persists in the trusted project's `.mcp.json`
if that file defines the server; otherwise, it persists in the global
`~/.pi/agent/mcp.json`. Untrusted project files are neither read nor changed.
The command reports which scope changed. It updates only the `disabled` option,
preserves other values (including secret references), and reformats the file as
indented JSON. Repeating a toggle that's already set leaves the file unchanged.

Both commands wait for active agent work to finish, then apply configuration as
`/mcp reload` does: connections close and reopen on demand, while unchanged active
tools from other servers remain available. Disabling removes the server from
search and deactivates its tools. Enabling does not connect, authenticate, or load
tools; ask the assistant to discover the capabilities you need. Other running Pi
sessions pick up the saved change when they reload their MCP configuration.

Use `/mcp get <server>` to check the effective transport, protocol, filters,
and connection status without connecting or running secret commands. Connection
values—including commands, arguments, URLs, headers, and environment variables—
are hidden because any of them can contain credentials.

Use `/mcp tools <server>` to fetch the current catalog and browse a scrollable
list. Each row shows the tool name and description, trimmed to the terminal width
with an ellipsis. Select a tool to see a multiline signature and parameter details,
with each parameter in a separate paragraph. Browsing respects your include and
exclude filters and doesn't activate tools or add their schemas to the assistant's
context. This command requires an interactive UI.

### Discovery and caching

Connections start on demand, never while the extension factory loads. A search
without a cached catalog contacts configured servers, with at most four discoveries
in flight. A server-scoped search only contacts that server. Activation discovers
only the servers named by its identifiers, with the same concurrency bound.
Failed servers are reported as unavailable, not mistaken for an empty catalog.

Catalogs are cached privately under `~/.pi/agent/cache/pi-mcp-client/`, keyed by
server configuration and working directory. Disk caches expire after 24 hours.
They contain tool metadata, not configured credentials. Cached discovery and
activation need no connection; invocation refreshes the live catalog before
calling the tool.
Connections remain open until shutdown or explicit reconnection.

When a connected server reports a tool-list change, the extension invalidates its
memory and disk catalogs. The next discovery or activation fetches the current
list, including new or removed tools. Notifications don't replace active tool
definitions: changed schemas require another `mcp_tools({activate: [...]})` before use. Disconnected, cache-only searches
can't receive notifications and still use the 24-hour disk-cache expiry.

### OAuth

Set `"oauth": true` under `mcpServers.<server>` in `mcp.json`, without an
Authorization header in its connection, then run `/mcp login <server>`. Pi opens the
browser only for this explicit command. Automatic discovery never opens a browser.

OAuth tokens and client registrations are stored in the operating system
credential store, bound to the server URL and authorization-server issuer.
There is no plaintext credential fallback. PKCE verifiers and callback state stay
in memory.

The initial implementation supports dynamically registered public clients with a
local callback at `http://127.0.0.1:19847/callback`. The browser must be able to
reach that address on the Pi machine. Authentication times out after two minutes;
you can cancel it with Escape in the terminal UI.
Pre-registered OAuth clients, remote callback pasting, and headless interactive
OAuth are not supported yet. Use bearer headers for headless access.

### Trust and permissions

Only load configuration you trust. Server executables and secret commands run
with your user permissions; trusted project configuration can replace global
connections and settings.

Server metadata is untrusted. Discovery never activates tools. Explicit
activation exposes schemas but does not approve tool side effects or provide
per-call confirmation. Use tool filters and Pi permission
extensions for additional controls. Cancelling a call does not guarantee that the
server rolled back its effects.

## 🧰 Requirements

- Pi 0.85.1 or later, with additive dynamic tool loading.
- Node.js 22 or later.
- The server executable for stdio connections.
- An available OS credential store for OAuth. Linux requires a working Secret
  Service/keyring session.

This extension uses `@modelcontextprotocol/client` 2.0.0 and defaults to automatic
SDK protocol-version negotiation. On stdio, negotiation probes using an additional
short-lived process. Set `"protocol": "legacy"` in a server definition if that
server requires an explicit legacy handshake.

## 🩺 Troubleshooting

Start with `/mcp`. Failures use a consistent code, a short explanation, and a
recovery hint, for example:

```text
linear: [authentication_required] Authentication is required. Run /mcp login linear.
```

Search and tool results also carry structured diagnostics in their result details:
`code`, `operation`, optional `server`, `message`, and `hint`. Partial discovery
keeps healthy servers' results and identifies servers it could not search. An
unavailable server is not an empty catalog.

| Code | What to check |
| --- | --- |
| `configuration_invalid` | JSON syntax, supported fields, transport type, and required environment variables. Reload Pi after editing. |
| `authentication_required` | Run `/mcp login <server>` for OAuth, or check the Authorization header. |
| `permission_denied` | Account permissions, OAuth scopes, and service access policy. |
| `credential_store_unavailable` | Unlock or enable the OS keyring; Linux needs a Secret Service session. |
| `secret_lookup_failed` | Secret helper installation, login, exit status, nonempty stdout, and output size. |
| `connection_failed` | Server executable, working directory, endpoint, network, and TLS configuration. |
| `timeout` | Server responsiveness and the applicable request, secret-command, or OAuth time limit. |
| `protocol_error` | Server compatibility and the `protocol` setting. |
| `tool_changed` | Server filters and the current tool schema; activate the exact identifier again. Reload Pi if connection configuration changed. |
| `tool_error` | The server's tool result and inputs; verify the outcome before retrying. |
| `oauth_failed` | Browser access to the callback and support for dynamically registered public clients. |
| `callback_unavailable` | Another process using local port 19847. |
| `busy` | Wait for discovery to finish before reconnecting. |
| `cancelled` | Retry when ready; verify any interrupted tool operation first. |
| `operation_failed` | An unclassified failure; inspect server status and configuration. |

Diagnostics never echo raw exception messages, HTTP bodies, command stderr,
credential values, or stack traces. Unknown errors stay generic rather than
being classified by potentially sensitive message text. Tool-call failures are
not replayed automatically; verify the outcome before retrying. Server-provided tool
results remain visible as content, even when the tool reports an error; they are
not sanitized transport diagnostics.

### Large results

Text results are limited to 2,000 lines or 50 KiB. Larger results are saved as
private temporary JSON files, with their paths included in the output. Supported
images pass through within an 8 MiB base64 budget; other binary content is kept in
the full result file. Temporary result files are not automatically deleted and
may contain sensitive data.

### v0.1 scope

The first release focuses on tools. Legacy SSE transport, MCP Apps, resource
browsing, prompt commands, roots, sampling, and elicitation are not supported.
See the [post-v0.1 backlog](https://github.com/mavam/pi-mcp-client/blob/main/TODO.md)
for follow-up work; it is not a release commitment.

## 🧹 Uninstall

```sh
pi remove npm:pi-mcp-client
```

## 📄 License

[MIT](LICENSE)
