# 🔌 Pi MCP Client

MCP tools and resources for Pi, discovered on demand through the official
TypeScript SDK. Read resources as context and call tools natively. No bridge
process and no invocation proxy.

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

Pi discovers tool and resource metadata, reads selected resources as context,
and explicitly activates tools before calling them natively. One `mcp_tools`
tool supports all three operations:

```js
// Discover tool and resource metadata. Never reads content or activates tools.
mcp_tools({ query: "database schema", server: "warehouse", limit: 5 })

// Read one resource into the conversation as a tool result.
mcp_tools({ read: { server: "warehouse", uri: "schema://analytics" } })

// Restrict discovery to tools when no resource context is needed.
mcp_tools({ query: "list teams", server: "linear", kind: "tools" })

// Activate exact identifiers. Never invokes.
mcp_tools({ activate: ["linear.list_teams", "linear.get_team"] })
```

Pass exactly one of `query`, `activate`, or `read`. The optional `kind`, `server`,
and `limit` fields are query-only; reads carry their server inside `read`.
`kind` defaults to `all`, or accepts `tools` and `resources`. Discovery returns up
to five candidates by default, or up to 50 with `limit`, across both kinds.

Tool candidates show an exact activation identifier, a short description,
required parameter names only, and `[loaded]` if already active. Resource
candidates show the owning server, title or name, exact URI, description, and
content type when supplied. Concrete resources and tools include exact next-call arguments; templates
include a read-call shape and variable names.
Search uses local BM25-based ranking of metadata, with names and resource titles
weighted more strongly than descriptions, and support for prefix matching.
Resource content isn't fetched or searched during discovery.

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
existing sessions. The UI labels discovery calls **mcp discover**, activation
calls **mcp activate**, and resource reads **mcp read**.

### Read resources as context

Ask Pi to use relevant context, such as a database schema or API guide. It can
discover the resource and read it without a browser, picker, or attachment dialog:

```js
mcp_tools({ query: "authentication guide", kind: "resources" })
mcp_tools({ read: { server: "docs", uri: "docs://authentication" } })
```

A read fetches one exact resource URI through its configured server's MCP
`resources/read` operation. It doesn't open a local file or make a generic HTTP
request, even for `file:` or `https:` URIs. There is no fallback when the server
can't read the URI. The server still controls which data it returns.

Tool-returned resource links include an exact `mcp_tools({read: ...})` call. Such
links can be read directly, without prior discovery or activation; linked
resources don't have to appear in the catalog.

Reading attaches content as the tool result itself, not as a second message. The
result identifies the source server and URIs and labels the content as untrusted
data. JSON and supported images use the existing result display. Large text is
truncated at 2,000 lines or 50 KiB; oversized results and unsupported binary
content are retained in a private temporary file. A resource read fetches the
server's full response before applying output limits; it isn't a streaming or
partial-content reader.

Reads never activate tools, start OAuth login, follow links in resource bodies,
or subscribe to live updates. Repeated reads fetch fresh content; earlier results
stay as snapshots. Resuming a session or navigating its branches doesn't re-read
resources. Resource content and selected metadata, including URIs, become session
data and may be sensitive. Private spill files can also contain sensitive data.

`includeTools` and `excludeTools` apply only to tools, not resources. Keeping
`mcp_tools` available permits resource reads from enabled servers, subject to the
server's authorization. `kind: "tools"` filters one search; it isn't an access
restriction. Disable a server to prevent all access, or exclude `mcp_tools` through
Pi's tool restrictions. Per-resource permission policies aren't implemented.

### Read parameterized resources

Resource discovery also lists URI templates, such as `schema://tables/{table}`,
without enumerating every possible table. Templates have a `[template]` label,
variable names, and a read-call shape whose arguments you fill with known values:

```js
mcp_tools({ query: "table schema", server: "warehouse", kind: "resources" })
mcp_tools({
  read: {
    server: "warehouse",
    template: "schema://tables/{table}",
    arguments: { table: "events" }
  }
})
```

Use either `uri` or `template` plus `arguments` inside `read`, never both. The
selected server must advertise the exact template. The official SDK expands
strings or string arrays into a concrete URI, then reads it through that same
server. Template variables aren't an input schema: no required fields or allowed
values are inferred. Use values from your request or prior results; Pi should
ask when a needed value is unknown rather than inventing an identifier.

Template reads use the same compact status row as exact reads:

```text
mcp read
 ✔︎ warehouse · schema://tables/events
```

Expanded output includes the template, supplied arguments, and resource content.
The same authorization, cancellation, output limits, and snapshot rules apply.
Template catalogs are memory-only, expire after five minutes, and are invalidated
with resource metadata. Argument data is limited to 64 KiB and expanded URIs to
4,096 characters. Argument completions and subscriptions aren't implemented.

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
| `/mcp add --scope <scope> [options] <server> <url>` | Save an HTTP server without connecting. For stdio, use `<server> -- <command> [args...]`. |
| `/mcp remove --scope <scope> <server>` | Remove a definition from the selected scope, retaining credentials. |
| `/mcp get <server>` | Inspect status and configuration, including disabled servers. Connection values are hidden. |
| `/mcp tools <server>` | Browse the server's tools and inspect descriptions without activating tools. |
| `/mcp reload` | Apply configuration changes without restarting Pi. |
| `/mcp enable <server>` | Enable a server in its effective configuration file. |
| `/mcp disable <server>` | Disable a server, close its connection, and deactivate its tools. |
| `/mcp login <server> [--no-browser]` | Authenticate an OAuth-enabled HTTP server; optionally paste the callback URL in an interactive dialog. |
| `/mcp logout <server>` | Remove local OAuth credentials and attempt remote revocation, including for disabled servers. |
| `/mcp reconnect <server>` | Replace a connection and refresh its catalog. |
| `/mcp refresh <server>` | Refresh tool and resource metadata without reading resources or loading additional tools. |

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
| `oauthClientId` | Optional pre-registered public client ID. Requires `oauth: true`; supports `${ENV_VAR}` interpolation, not secret commands. |
| `oauthScopes` | Optional array of 1–100 unique OAuth scope tokens to request at login. Requires `oauth: true`; omitted scopes use SDK/server defaults. Values are literal, without interpolation. |
| `oauthCallbackPort` | Optional loopback callback port, from 1 to 65535. Defaults to `19847`. Requires `oauth: true`. |
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
are hidden because any of them can contain credentials. Authentication status shows
whether OAuth tokens are stored, not whether they are valid. A locked or unavailable
credential store is reported separately from missing tokens. Header and stdio
credentials are identified as externally managed; inspection never executes them.

Use `/mcp tools <server>` to fetch the current catalog and browse a scrollable
list. Each row shows the tool name and description, trimmed to the terminal width
with an ellipsis. Select a tool to see a multiline signature and parameter details,
with each parameter in a separate paragraph. Browsing respects your include and
exclude filters and doesn't activate tools or add their schemas to the assistant's
context. This command requires an interactive UI.

### Add and remove servers

Both commands require an explicit `--scope global` or `--scope project`:

- **Global:** `~/.pi/agent/mcp.json`.
- **Project:** `.mcp.json` in the current trusted project. Untrusted project files
  are neither read nor changed.

Add an HTTP server by URL, or a stdio server after `--`:

```text
/mcp add --scope global docs https://docs.mcp.cloudflare.com/mcp
/mcp add --scope project local -- node "/path with spaces/server.js"
```

Put options before the server name. `--transport http` or `--transport stdio` is
optional; the URL form selects HTTP and the `--` form selects stdio. Arguments
support single and double quotes and backslash escaping, but are never evaluated
by a shell. Shell syntax such as `$(...)`, pipes, and globs stays literal. For
Windows paths with backslashes, single quotes preserve the path verbatim.

Additional options:

| Option | Purpose |
| --- | --- |
| `--replace` | Replace the complete definition in the selected scope, or create an override of a same-named definition in the other scope. Existing fields are not merged. |
| `--header 'Name: value'` | Add an HTTP header. Repeat for different header names. |
| `--env KEY=value` | Add a stdio environment override. Repeat for different variable names. |
| `--oauth` | Enable OAuth for an HTTP server. |
| `--oauth-client-id ID` | Use a pre-registered public client. Requires `--oauth`. |
| `--oauth-scope SCOPE` | Request an OAuth scope. Repeat for additional scopes. Requires `--oauth`. |
| `--oauth-callback-port PORT` | Set the loopback callback port. Requires `--oauth`. |

For example, retain an environment reference rather than typing a token:

```text
/mcp add --scope global --header 'Authorization: Bearer ${DOCS_TOKEN}' docs https://mcp.example.com/mcp
/mcp add --scope global --oauth --oauth-client-id '${CLIENT_ID}' service https://mcp.example.com/mcp
```

Define referenced environment variables before running the command. Validation
checks the resolved configuration, but saves the references, not their values.
Secret commands in headers or environment overrides are saved without running
them. Avoid typing literal credentials in command input or project files; use
[environment references and secret commands](#secret-commands) instead.

Adding never starts a server, opens a browser, or activates tools. Duplicate names
in global or trusted project configuration are rejected unless you supply
`--replace`. Project definitions take precedence; writing a global definition does
not replace a project override. Other server options, such as tool filters, remain
available by editing the configuration file.

Remove a definition from a specific scope:

```text
/mcp remove --scope project local
```

Removal is distinct from disabling and logout: it deletes the selected definition,
not its OAuth credentials. Run `/mcp logout <server>` first if you also want to
remove credentials. Removing a project override exposes any same-named global
definition; the command reports when a definition in the other scope remains.
Removing a name absent from the selected scope fails without changing either file.

Successful edits apply immediately using the same connection and tool reconciliation
as `/mcp reload`. Connections close and reopen on demand; tools whose effective
definition changed or disappeared are deactivated, while unchanged active tools
remain available. Other Pi sessions pick up saved changes when they reload.

Writes preserve unrelated settings, follow existing file symlinks, and replace
files atomically. New files are private; existing file permissions are preserved.
If global and project configuration point to the same file, scoped edits are
refused until you separate them. Empty configuration files are retained rather
than deleted.

### Discovery and caching

Connections start on demand, never while the extension factory loads. A search
without the requested cached metadata contacts configured servers, with at most
four server discoveries in flight. A server-scoped search only contacts that server. Activation discovers
only the servers named by its identifiers, with the same concurrency bound.
Failed servers are reported as unavailable, not mistaken for an empty catalog.

Tool catalogs are cached privately under `~/.pi/agent/cache/pi-mcp-client/`, keyed by
server configuration and working directory. Disk caches expire after 24 hours.
They contain tool metadata, not configured credentials. Cached tool-only discovery
and activation need no connection; invocation refreshes the live catalog before
calling the tool.

Resource metadata is held only in memory for up to five minutes, not written to
the tool catalog cache. Mixed discovery therefore may connect even when tools
are cached on disk. Resource-list notifications, disconnection, and explicit
refresh invalidate resource metadata without reading content. Tool and resource
catalog failures are reported independently; healthy candidates remain available.
The SDK handles pagination. Resource catalogs are limited to 10,000 entries and
4 MiB of descriptor data; oversized catalogs fail rather than silently returning
a partial list. Reads bypass the SDK content cache.
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
credential store, bound to the server URL, configured client ID (if any), and
authorization-server issuer.
There is no plaintext credential fallback. PKCE verifiers and callback state stay
in memory.

Run `/mcp logout <server>` to remove stored tokens and client registrations. Logout
also closes connections and deactivates tools for configured OAuth servers sharing
the same URL and configured client ID, since they share credentials. Configuration and enabled state stay
unchanged. Disabled servers accept logout too. Header and server-managed credentials
remain untouched.

Local removal happens before a bounded attempt to revoke tokens at the original
authorization server. The result distinguishes accepted revocation, unsupported
revocation, and unconfirmed revocation. When revocation isn't confirmed, remove the
grant at the service if needed. Repeating logout is safe. Other running Pi sessions
may need to reconnect; logout cannot recall requests already sent to a server.
No browser opens until you explicitly run `/mcp login <server>`.

Public clients can use dynamic registration or a pre-registered client ID. Both
use PKCE and a loopback callback at `http://127.0.0.1:19847/callback` by default.
Normal login opens a local listener that the browser must be able to reach.
Authentication times out after two minutes; you can cancel it with Escape in the
terminal UI. Explicit login always starts a fresh authorization flow, even if a
refresh token is already stored. The browser callback page identifies **Pi MCP
Client** and asks you to return to Pi; receiving a callback doesn't yet mean the
token exchange succeeded.

For a server without dynamic registration, register a **public/native** client
with the service, using that exact callback URL and token endpoint authentication
method `none`. Then configure its client ID:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": true,
      "oauthClientId": "${EXAMPLE_OAUTH_CLIENT_ID}"
    }
  }
}
```

Run `/mcp reload`, then `/mcp login example`. The configured ID is used for login,
token refresh, and revocation; Pi never falls back to dynamic registration if it
is rejected. `/mcp get example` identifies the client as pre-registered without
printing the ID.

Changing the client ID selects separate credentials and requires a new login.
Log out before changing or removing the ID if you want to delete its old
credentials. After the first successful grant, a pre-registered client is pinned
to its authorization-server issuer. If that issuer changes, verify the server
configuration before logging out and logging in again to trust the replacement.

#### Requested scopes and callback ports

Configure scopes and a callback port in the server definition:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": true,
      "oauthScopes": ["read", "write"],
      "oauthCallbackPort": 19848
    }
  }
}
```

Or set them when adding the server:

```text
/mcp add --scope global --oauth --oauth-scope read --oauth-scope write --oauth-callback-port 19848 example https://mcp.example.com/mcp
```

The callback becomes `http://127.0.0.1:19848/callback`. Pre-registered clients must
allow that exact URL. The listener stays bound to loopback; arbitrary callback
hosts and paths aren't supported. If the port is occupied, choose another port or
use manual login.

Scopes are case-sensitive OAuth tokens, each up to 256 characters, without spaces,
quotes, or backslashes. Omit `oauthScopes` to retain SDK/server-driven selection;
an empty array is rejected. The SDK may also request `offline_access` when the
service advertises refresh-token support. Requested scopes aren't a guarantee of
granted permissions or a per-tool permission policy.

After changing these options, run `/mcp reload`, then `/mcp login example`.
Changing configuration never starts authorization or revokes existing grants.
Scopes and callback ports don't select separate credential stores: definitions
sharing a URL and client ID still share credentials. Explicit login renews a
dynamic registration when its requested options change. `/mcp get example` shows
the requested scopes and callback address without connecting.

#### Manual and remote login

When Pi runs over SSH, or you don't want it to launch a browser, use:

```text
/mcp login example --no-browser
```

1. Open the authorization URL shown in Pi's interactive dialog in your browser.
2. Complete sign-in. The browser may show a connection error at the loopback
   callback address; this is expected when the browser and Pi run on different
   machines.
3. Copy the full callback URL from the browser's address bar and paste it into
   the **Callback URL** dialog in Pi, not into chat or a slash command.

Manual login doesn't open a browser or bind a callback port. Pi validates the
callback address, state, and authorization response before exchanging the code.
Authorization URLs and pasted callbacks aren't written to session entries,
catalogs, notifications, or logs by this extension. Treat the callback URL as
sensitive; your browser history and clipboard may still contain it.

`--no-browser` still requires an interactive UI and an available OS credential
store. It isn't unattended authentication: print and JSON modes refuse OAuth
login. Use externally managed bearer headers for unattended access. Confidential
clients requiring a client secret aren't supported yet.

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
| `resource_invalid` | Use an exact absolute resource URI from discovery or a tool-returned link. |
| `resource_not_found` | Refresh resource metadata or obtain a new link. |
| `resources_unsupported` | Use the server's tools instead, or choose a resource-capable server. |
| `catalog_changed` | Retry discovery after the server catalog settles. |
| `oauth_failed` | Browser access to the callback and support for public clients, using dynamic registration or the configured client ID. |
| `oauth_issuer_changed` | Verify the authorization-server change before logging out and logging in again. |
| `callback_unavailable` | Another process using the configured loopback port (default 19847). Change `oauthCallbackPort` or use `/mcp login <server> --no-browser`. |
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

## 📄 License

[MIT](LICENSE)
