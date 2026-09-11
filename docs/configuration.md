# Configuration

[Back to the README](../README.md)

You configure which servers the model can access. Add connections to
`~/.pi/agent/mcp.json`, or `.mcp.json` in a trusted project. For command-based
setup, see [Add and remove servers](commands.md#add-and-remove-servers). To reuse
an existing Claude/Cursor JSON or Codex TOML file, see
[Import server definitions](commands.md#import-server-definitions).

## Files and transports

The files use the common Claude/Cursor-style `mcpServers` format, not a universal
MCP configuration standard. Live configuration must use JSON, not VS Code's
`servers` format or Codex TOML. The import command can translate Codex TOML into
this format. `PI_CODING_AGENT_DIR` overrides the global Pi directory.
Project definitions replace same-named global definitions in full; fields and
filters aren't merged. Untrusted project definitions aren't loaded or edited.
An explicitly named import source is read as data for review; saving into project
scope still requires project trust.

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      }
    },
    "local": {
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

Only stdio and Streamable HTTP are supported. The extension rejects `type: "sse"`
and unsupported connection fields rather than silently changing their meaning.

The extension uses `@modelcontextprotocol/client` 2.0.0 and defaults to automatic
SDK protocol-version negotiation. On stdio, negotiation probes using an additional
short-lived process. Set `"protocol": "legacy"` if the server requires an explicit
legacy handshake.

## Secret commands

In **`headers` and stdio `env` values only**, a leading `!` runs a secret-generating
shell command when the server connects:

```json
{
  "mcpServers": {
    "example": {
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
searches and activations can connect and therefore execute commands. Concurrent
connection requests share the same resolution.

The extension trims stdout and rejects empty output, nonzero exits, output above
64 KiB, and resolution taking more than 10 seconds (or a shorter `timeoutMs`).
Session shutdown cancels pending commands. Cancelling an individual search or
activation stops waiting but leaves shared connection work running for other
callers.

The extension discards command stderr and doesn't include resolved secrets in
errors, session records, or catalog caches. Commands themselves remain responsible
for avoiding side effects or writing secrets to disk. Only configure commands you
trust; project configuration still requires project trust.

## Pi-specific options

Put descriptions, authentication choices, filters, and timeouts directly in each
server definition:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "description": "Search product documentation",
      "includeTools": ["get_*", "search_*"]
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `description` | Short capability description for the model's server directory. |
| `oauthClientId` | Optional pre-registered public client ID. Supports `${ENV_VAR}` interpolation, not secret commands. |
| `oauthScopes` | Optional array of 1–100 unique OAuth scope tokens to request at login. Omitted scopes use SDK/server defaults. Values are literal, without interpolation. |
| `oauthCallbackPort` | Optional loopback callback port, from 1 to 65535. Defaults to `19847`. |
| `disabled` | Prevent this server from connecting or exposing tools and resources. |
| `includeTools` | Optional allowlist of original MCP tool names; `*` matches any sequence. An empty list exposes no tools. |
| `excludeTools` | Denylist applied after `includeTools`. |
| `timeoutMs` | Request timeout, from 100 to 600000 ms. Defaults: 15 seconds for discovery/HTTP requests, 30 seconds for stdio tool calls. |
| `startupTimeoutMs` | Optional timeout for SDK connection setup and protocol negotiation, from 100 to 600000 ms. Defaults to `timeoutMs` or 15 seconds. |
| `toolTimeoutMs` | Optional timeout for tool calls only, from 100 to 600000 ms. Overrides `timeoutMs` for calls without changing metadata or resource deadlines. |
| `protocol` | `auto` (default) for SDK protocol-version negotiation, or `legacy` for an explicit legacy handshake. |

OAuth client IDs, scopes, and callback ports require HTTP without an Authorization
header. HTTP authentication is automatic; remove the obsolete `oauth` field from
existing definitions. See [authentication](authentication.md).

Every definition must include a `url` or `command`, even when `disabled` is true.
These options are specific to Pi MCP Client, not standardized MCP connection
fields. Other clients may reject them when you copy a definition. The import command
accepts only its documented subset of server fields and refuses unsupported
entries rather than dropping options.

Tool filters don't restrict resource reads. See
[trust and permissions](behavior.md#trust-and-permissions) for access boundaries
and [authentication](authentication.md) for OAuth setup.

## Apply changes

After editing a file, run `/mcp reload`. The extension validates the new
configuration before replacing the current setup; invalid configuration leaves
the previous setup intact. Reload closes connections, which reopen on demand,
and deactivates tools from changed, removed, or disabled definitions. Unchanged
active tools remain available.

Server-management commands apply saved changes using the same reconciliation.
Other running Pi sessions pick up those changes when you reload their MCP
configuration. See [Commands](commands.md) for toggling, inspecting, adding, and
removing servers.
