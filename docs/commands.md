# Commands

[Back to the README](../README.md)

These are commands **you run in Pi**, not tools the assistant calls. Use them to
manage servers, inspect capabilities, use prompts, and watch resource changes. The assistant's
separate interface is documented in the [tool reference](tool-reference.md).

## Command reference

| Command | Purpose |
| --- | --- |
| `/mcp`, `/mcp list`, `/mcp status` | Show a server status matrix with catalog and loaded-tool counts. |
| `/mcp add --scope <scope> [options] <server> <url>` | Save an HTTP server without connecting. For stdio, use `<server> -- <command> [args...]`. |
| `/mcp remove --scope <scope> <server>` | Remove a definition from the selected scope, retaining credentials. |
| `/mcp import --scope <scope> <path>` | Preview and select servers from a Claude/Cursor-style JSON file, then confirm a scoped import. |
| `/mcp get <server>` | Inspect status and configuration, including disabled servers. Connection values are hidden. |
| `/mcp tools <server>` | Browse the server's tools and inspect descriptions without activating tools. |
| `/mcp prompts <server>` | Browse prompt metadata, then select a prompt and enter arguments. |
| `/mcp prompt <server> <name> [argument=value ...]` | Open a named prompt with prefilled arguments, then fetch and review a preview. |
| `/mcp reload` | Apply configuration changes without restarting Pi. |
| `/mcp enable <server>` | Enable a server in its effective configuration file. |
| `/mcp disable <server>` | Disable a server, close its connection, and deactivate its tools. |
| `/mcp login <server> [--no-browser]` | Authenticate an HTTP server without changing its configuration; optionally paste the callback URL in an interactive dialog. |
| `/mcp logout <server>` | Remove local OAuth credentials and attempt remote revocation, including for disabled servers. |
| `/mcp reconnect <server>` | Replace a connection and refresh its catalog. |
| `/mcp refresh <server>` | Refresh tool, resource, and prompt metadata without fetching content or loading additional tools. |
| `/mcp subscribe <server> <uri>` | Watch changes to one exact resource URI without fetching content. |
| `/mcp unsubscribe <server> <uri>` | Stop watching one resource. |
| `/mcp subscriptions` | List active resource watches and their change markers. |

See [Authentication](authentication.md) for login and logout procedures, and
[Apply changes](configuration.md#apply-changes) for reload behavior.

## Inspect servers and tools

The `/mcp` status matrix distinguishes idle (`○`), connected (`●`), connecting
(`▶︎`), disabled (`○`), and failed (`✘︎`) servers. Idle is normal: connections open
on demand. A dash (`—`) means the catalog hasn't been fetched, not that the server
has no tools. The **Loaded** column counts tools currently active for the
assistant.

Use `/mcp get <server>` to check the effective transport, protocol, filters,
and connection status without connecting or running secret commands. Connection
values—including commands, arguments, URLs, headers, and environment variables—
are hidden because any of them can contain credentials. Authentication status
shows whether OAuth tokens are stored, not whether they are valid. A locked or
unavailable credential store is reported separately from missing tokens. Header
and stdio credentials are identified as externally managed; inspection never
executes them.

Use `/mcp tools <server>` to fetch the current catalog and browse a scrollable
list. Rows show tool names and descriptions, trimmed to the terminal width with
an ellipsis. Select a tool to see a multiline signature and parameter details,
with each parameter in a separate paragraph. Browsing respects your include and
exclude filters and doesn't activate tools or add their schemas to the assistant's
context. This command requires an interactive UI.

Refreshing a catalog doesn't replace active tool definitions. After a schema
change, ask the assistant to activate the exact tool again. See
[tool changes and caching](behavior.md#discovery-and-caching). Failed tool calls
aren't retried automatically; verify whether an interrupted operation completed
before trying again.

## Use server prompts

Prompts are server-maintained task instructions that **you** choose to use. For a
server that provides an `explain` prompt, browse or open it directly:

```text
/mcp prompts docs
/mcp prompt docs explain topic="OAuth flows"
```

1. Select a prompt. Browsing fetches metadata only and doesn't add anything to the
   conversation.
2. Select an argument to edit its string value. Required arguments must be supplied;
   optional arguments can remain omitted. An empty string is distinct from an
   omitted value. Inline `argument=value` pairs prefill the editor. Quoting follows
   the configuration commands' rules, without shell or environment expansion.
3. Choose **Fetch preview** to send the arguments to the selected MCP server.
   Your conversation and local files aren't automatically shared. Argument values
   are limited to 4,096 characters each and 64 KiB in total.
4. Review the source-labeled messages using **Next page** and **Previous page**.
   Choose **Back** to change arguments, or **Cancel** to discard the preview.
5. Choose **Use prompt** to send exactly the reviewed snapshot to the model and
   start a turn. This saves the content in the session. No second fetch occurs.

Text and embedded text resources are supported. Images, audio, binary resources,
and other unsupported blocks are identified in the preview and prevent use of the
whole prompt; they aren't silently omitted. Prompts exceeding 2,000 lines or
50 KiB are refused, not truncated or written to spill files. Links aren't followed.

These commands require an interactive TUI or RPC session. In the TUI, press Escape
to cancel a pending fetch. Cancelling doesn't undo arguments already sent to the
server. Using a prompt doesn't activate tools or approve their side effects. See
[prompt snapshots](behavior.md#prompt-snapshots) for trust and lifecycle behavior.

## Enable and disable servers

Use `/mcp disable <server>` or `/mcp enable <server>` to change the `disabled`
option without editing JSON. The command reports which scope changed: the trusted
project's `.mcp.json` if it defines the server, otherwise the global
`~/.pi/agent/mcp.json`. Untrusted project files are neither read nor changed.

Toggles preserve other values, including secret references, and reformat the file
as indented JSON. Repeating a toggle that's already set leaves the file unchanged.
Both commands wait for active agent work to finish, then
[apply the configuration](configuration.md#apply-changes).

Disabling removes the server from discovery and deactivates its tools. Enabling
doesn't connect, authenticate, or load tools; ask the assistant to discover the
capabilities you need.

## Add and remove servers

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

| Option | Purpose |
| --- | --- |
| `--replace` | Replace the complete definition in the selected scope, or create an override of a same-named definition in the other scope. Existing fields aren't merged. |
| `--header 'Name: value'` | Add an HTTP header. Repeat for different header names. |
| `--env KEY=value` | Add a stdio environment override. Repeat for different variable names. |
| `--oauth-client-id ID` | Use a pre-registered public client. |
| `--oauth-scope SCOPE` | Request an OAuth scope. Repeat for additional scopes. |
| `--oauth-callback-port PORT` | Set the loopback callback port. |

Retain environment references rather than typing tokens:

```text
/mcp add --scope global --header 'Authorization: Bearer ${DOCS_TOKEN}' docs https://mcp.example.com/mcp
/mcp add --scope global --oauth-client-id '${CLIENT_ID}' service https://mcp.example.com/mcp
```

Define referenced environment variables before running the command. Validation
checks the resolved configuration, but saves the references, not their values.
Secret commands in headers or environment overrides are saved without running
them. Avoid literal credentials in command input or project files; use
[environment references and secret commands](configuration.md#secret-commands).

Adding never starts a server, opens a browser, or activates tools. Duplicate names
in global or trusted project configuration are rejected unless you supply
`--replace`. Project definitions take precedence; writing a global definition
doesn't replace a project override. Other server options, such as tool filters,
remain available by editing the configuration file.

Remove a definition from a specific scope:

```text
/mcp remove --scope project local
```

Removal is distinct from disabling and logout: it deletes the selected definition,
not its OAuth credentials. Run `/mcp logout <server>` first if you also want to
remove credentials. Removing a project override exposes any same-named global
definition; the command reports when a definition in the other scope remains.
Removing a name absent from the selected scope fails without changing either file.

Successful edits [apply immediately](configuration.md#apply-changes). Writes
preserve unrelated settings, follow existing file symlinks, and replace files
atomically. New files are private; existing file permissions are preserved. If
global and project configuration point to the same file, scoped edits are refused
until you separate them. Empty configuration files are retained rather than deleted.

## Import server definitions

Import from an explicitly named local JSON file:

```text
/mcp import --scope project "/path with spaces/mcp.json"
```

The command requires an interactive TUI or RPC session and an explicit
`--scope global` or `--scope project`. Project scope requires a trusted project.
Relative source paths resolve against Pi's current directory; `~/` is supported.
The path isn't evaluated by a shell, and no application settings are scanned.

1. If the source contains other top-level settings, confirm that only
   `mcpServers` should be considered. Nested project settings aren't traversed.
2. Review each server's name, transport, enabled state, and any validation or
   unsupported-field problems. Commands, arguments, URLs, headers, and environment
   values stay hidden. Review the original file before importing connections you
   don't already trust. Unsupported entries can only be skipped; their fields
   aren't silently dropped.
3. Choose **Skip**, add the definition, or **Choose a different name**. Name
   conflicts require an explicit replacement or override choice. A replacement
   replaces the entire definition, including headers and environment variables;
   credentials and other fields aren't merged. A global import shadowed by a
   project definition is labeled as such and doesn't change the effective server.
4. Review the selected destination names and actions, then confirm the import.
   The confirmation warns that inline credentials are copied with the selected
   definitions. Existing Pi OAuth credentials are retained, but no external
   credential store is read or migrated.

Nothing is saved until the final confirmation. Cancellation, a session or trust
change, or a changed destination configuration prevents saving the preview. All
selected definitions are validated and written together using one atomic file
replacement, then applied through the normal configuration reconciliation.
The source snapshot isn't reread after confirmation, and the source and
destination cannot be the same file. No server starts, secret command runs,
login opens, or tool activates during import. Enabled connections become
available on demand afterward; imported disabled servers stay disabled.

The initial format is a top-level `mcpServers` object in strict UTF-8 JSON, limited
to 1 MiB and 100 servers. Supported server fields are `type`, `command`, `args`,
`cwd`, `env`, `url`, `headers`, `disabled`, and `description`. Only stdio and
Streamable HTTP are supported. JSON comments, trailing commas, SSE, nested Claude
project settings, VS Code, Codex, and MCPorter formats aren't supported.

`${VAR}` references are preserved and must resolve in Pi before import. Default
expressions and client-specific variables such as `${env:TOKEN}` or
`${workspaceFolder}` are refused rather than translated. In environment and
header values, bare `$VAR` and leading `!` remain literal: the importer escapes
them so they don't become Pi variable expansions or secret commands. Other
connection values retain Pi's normal interpolation rules. Relative executable,
argument, and working-directory paths retain Pi's path semantics, not the source
application's or import file's directory; verify them before importing.

## Watch resource changes

Subscriptions are explicit user commands, not model-facing tool operations:

```text
/mcp subscribe warehouse schema://tables/events
/mcp subscriptions
/mcp unsubscribe warehouse schema://tables/events
```

Use an exact absolute URI from discovery, a template read, or a resource link.
The configured server must support resource subscriptions. The extension uses the
SDK's negotiated protocol: legacy resource subscriptions or modern filtered
streams. It never opens the URI as a file or generic URL.

An update marks the watch as changed (`↻`) and shows a UI notification. Repeated
updates coalesce into that marker until you unsubscribe. No content is fetched,
no model turn starts, and existing resource results remain unchanged. Ask the
assistant to read the resource for a new snapshot; unsubscribe and subscribe again
to reset the change marker.

Watches are memory-only, limited to 50 per server connection, and require an
interactive UI (TUI or RPC). Repeating a subscribe command is idempotent. Session
replacement, tree navigation, configuration reload, disconnection, and exit clear
the affected watches. They are never restored or automatically retried; use
`/mcp subscriptions` to inspect active watches. Cancellation and connection
failures can leave an uncertain server-side outcome; cleanup is best-effort.
