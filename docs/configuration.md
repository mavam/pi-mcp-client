# Configuration

[Back to the README](../README.md)

You configure which servers the model can access. Add connections to
`~/.pi/agent/mcp.json`, or `.pi/mcp.json` in a
[trusted project](behavior.md#project-trust). For command-based setup, see
[Add and remove servers](commands.md#add-and-remove-servers). To reuse an
existing Claude/Cursor JSON or Codex TOML file, see
[Import server definitions](commands.md#import-server-definitions).

## Files and transports

The files use the `mcpServers` format that Pi's built-in MCP support reads, so the
same files work with either extension; see
[Pi's built-in MCP support](behavior.md#pis-built-in-mcp-support). The shape
matches other clients for `command`, `args`, `env`, `url`, and `headers`, but it
isn't a universal MCP configuration standard. Live configuration must use JSON,
not VS Code's `servers` format or Codex TOML. The import command can translate
Codex TOML into this format. `PI_CODING_AGENT_DIR` overrides the global Pi
directory. Project definitions replace same-named global definitions in full;
fields and filters aren't merged. Untrusted project definitions aren't loaded or
edited; see [project trust](behavior.md#project-trust). An explicitly named
import source is read as data for review; saving into project scope still
requires project trust.

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
| `type` | Optional `stdio`, `http`, or `streamable-http`. If omitted, inferred from `command` or `url`. A conflicting type is rejected. |
| `command`, `args` | Executable and arguments for a stdio server. No shell is used. |
| `cwd` | Working directory for stdio; defaults to Pi's current directory. Relative paths resolve there. |
| `env` | Environment variables for stdio, in addition to a minimal inherited set. |
| `url` | Streamable HTTP endpoint; mutually exclusive with `command`. |
| `headers` | HTTP request headers, including optional bearer authentication. |

Strings in `command`, `args`, `cwd`, `env`, `url`, and `headers` support `${VAR}`
interpolation. Missing variables prevent that server from connecting.

Stdio servers don't inherit Pi's environment. They receive only the MCP SDK's
default set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, and `USER` on Unix, and
similar system variables on Windows) plus `env`. Pass other variables a server
needs explicitly, for example a custom browser location:

```json
"env": {
  "PLAYWRIGHT_BROWSERS_PATH": "${PLAYWRIGHT_BROWSERS_PATH}"
}
```

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
64 KiB, and resolution taking more than 10 seconds (or a shorter `timeout`).
Session shutdown cancels pending commands. Cancelling an individual search or
activation stops waiting but leaves shared connection work running for other
callers.

The extension discards command stderr and doesn't include resolved secrets in
errors, session records, or catalog caches. Commands themselves remain responsible
for avoiding side effects or writing secrets to disk. Only configure commands you
trust; project configuration still requires project trust.

## Options

Put descriptions, authentication choices, filters, and timeouts directly in each
server definition:

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "description": "Search product documentation",
      "exposure": "hidden",
      "toolExposure": { "get_*": "codemode", "search_*": "codemode" }
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `description` | Short capability description for the model's server directory. Only this extension reads it. |
| `enabled` | Set to `false` to prevent this server from connecting or exposing tools and resources. |
| `exposure` | Pi's exposure mode for the server's tools. Only `hidden` has an effect here: the model always discovers tools and then activates them. Other values are accepted so one file works with Pi's built-in support. |
| `toolExposure` | Exposure per tool. Keys are original MCP tool names, or patterns where `*` matches any sequence. An exact name wins over patterns; among patterns, the first match wins. With `"exposure": "hidden"`, only tools listed with another mode are visible. |
| `timeout` | Request timeout in seconds, from 0.1 to 600. Defaults: 15 seconds for discovery/HTTP requests, 30 seconds for stdio tool calls. |
| `startupTimeout` | Optional timeout in seconds for SDK connection setup and protocol negotiation. Defaults to `timeout` or 15 seconds. Only this extension reads it. |
| `toolTimeout` | Optional timeout in seconds for tool calls only. Overrides `timeout` for calls without changing metadata or resource deadlines. Time spent answering [server requests](behavior.md#server-requests-for-input) doesn't count. Only this extension reads it. |
| `protocol` | `auto` (default) for SDK protocol-version negotiation, or `legacy` for an explicit legacy handshake. Only this extension reads it. |
| `oauth` | OAuth options for HTTP servers, described below. |

The `oauth` object takes these fields:

| Field | Purpose |
| --- | --- |
| `clientId` | Optional pre-registered public client ID. Supports `${ENV_VAR}` interpolation, not secret commands. |
| `scope` | Optional space-separated list of 1–100 unique OAuth scope tokens to request at login. Omitted scopes use SDK/server defaults. Values are literal, without interpolation. |
| `callbackPort` | Optional loopback callback port, from 1 to 65535. Defaults to `19847`. |
| `dpop` | Opt in to DPoP proofs with ES256 keys stored in the OS keyring. Defaults to `false`. Run a fresh login after enabling it. Only this extension reads it. |

`oauth.clientSecret` and `oauth.callbackUrl`, which Pi's built-in support accepts,
are rejected: this extension supports public clients with loopback port callbacks.

OAuth options require HTTP without an Authorization header. HTTP authentication is
automatic. See [authentication](authentication.md).

Every definition must include a `url` or `command`, even when `enabled` is
`false`. The import command accepts only its documented subset of server fields
and refuses unsupported entries rather than dropping options.

Tool filters don't restrict resource reads. See
[trust and permissions](behavior.md#trust-and-permissions) for access boundaries
and [authentication](authentication.md) for OAuth setup.

## Invalid servers

An invalid server entry is skipped with a warning, and the other servers still
load, as in Pi's built-in MCP support. Warnings name the server and the invalid
field, never its values. A file that isn't valid JSON, or that has no `mcpServers`
object, fails as a whole. Skipped entries stay in the file, so you can fix them or
remove them with `/mcp remove`.

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
