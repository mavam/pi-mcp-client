This release expands Pi’s MCP integration with on-demand resource discovery, parameterized reads, completions, and explicit subscriptions, alongside a more capable OAuth login flow. It also adds scoped server management and consistent MCP command and status conventions.

## 💥 Breaking changes

### Consistent MCP management command names

MCP management now uses the same command names as Codex and Claude Code:

- Replace `/mcp auth <server>` with `/mcp login <server>`.
- Replace `/mcp inspect <server>` with `/mcp get <server>`.

The old names are no longer accepted. Authentication and redacted server inspection otherwise behave as before.

*By @mavam in #10.*

## 🚀 Features

### MCP logout and authentication status

You can now remove stored MCP OAuth credentials with `/mcp logout <server>`, including for disabled servers. Logout closes related connections and deactivates their tools, but preserves configuration and enabled state. Header and server-managed credentials remain untouched.

Logout reports local removal separately from best-effort remote token revocation. When revocation cannot be confirmed, revoke access at the service if needed.

Use `/mcp get <server>` to see the authentication method and whether OAuth tokens are stored. Inspection never validates tokens online or exposes their values.

*By @mavam in #11.*

### OAuth scopes, callback ports, and manual login

You can now request OAuth scopes, choose a loopback callback port, and sign in from a remote Pi session without launching a browser on the Pi machine.

Use `/mcp login example --no-browser` to open an interactive dialog with an authorization URL. Complete sign-in in your browser, then paste the full callback URL into the dialog—not into chat. Manual login doesn't bind a local port and still requires an interactive UI and an OS credential store.

Set `oauthScopes` and `oauthCallbackPort` in the server definition, or supply them when adding a server:

```text
/mcp add --scope global --oauth --oauth-scope read --oauth-callback-port 19848 example https://mcp.example.com/mcp
```

Omitted scopes retain SDK/server defaults, and the default callback port remains 19847. Pre-registered clients must allow the configured callback URL. After changing options, reload MCP configuration and log in again. `/mcp get example` shows the requested scopes and callback address. The browser callback page now uses Pi's logo with a Pi MCP Client label and clear return-to-Pi guidance.

*By @mavam in #14.*

### On-demand MCP resource discovery and reading

Pi can now discover MCP resources alongside tools and read selected resources directly into the conversation, without a manual resource browser.

```js
mcp_tools({ query: "database schema", server: "warehouse" })
mcp_tools({ read: { server: "warehouse", uri: "schema://analytics" } })
```

Discovery searches metadata only and now defaults to both tools and resources. Set `kind: "tools"` for tool-only discovery or `kind: "resources"` for resources. Each candidate includes exact next-call arguments. Resource links returned by tools can be read without prior discovery or activation, including resources absent from the catalog.

Reads return bounded, attributed context without activating tools or making an extra attachment message. Large text and unsupported binary content use private result files. Resource catalog changes invalidate metadata without fetching content; earlier reads remain snapshots. Tool activation and native invocation are unchanged.

Resource reads go only through the configured MCP server, never through a generic URL fetch or local-file fallback. Tool-name filters do not restrict resources. Resource templates and subscriptions remain unsupported.

*By @mavam in #15.*

### Parameterized MCP resource reads

Pi can now discover resource URI templates and read parameterized resources without enumerating every possible URI.

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

Templates appear alongside resources with a template label, variable names, and a read-call shape. Use known values as strings or string arrays; variable names do not imply required fields or allowed values. The selected server must advertise the template, and the expanded URI is read only through that server.

The status row shows the concrete resource URI. Expanded output includes the template, supplied arguments, and resource content. Discovery remains metadata-only, and template reads neither activate tools nor replay when a session resumes. Argument completions and subscriptions remain out of scope.

*By @mavam in #16.*

### Pre-registered public OAuth clients

You can now connect to OAuth servers that require a pre-registered public client instead of supporting dynamic registration. Set `oauth: true` and `oauthClientId` in the server definition, then run `/mcp login <server>`:

```json
{
  "url": "https://mcp.example.com/mcp",
  "oauth": true,
  "oauthClientId": "${EXAMPLE_OAUTH_CLIENT_ID}"
}
```

Register the client with callback `http://127.0.0.1:19847/callback` and token endpoint authentication method `none`. Client secrets are not supported.

Credentials are isolated by client ID, and successful grants stay bound to their authorization-server issuer. Inspection identifies pre-registered clients without printing the ID. Logout removes only credentials for the configured client.

*By @mavam in #12.*

### Resource argument completions and explicit subscriptions

Pi can now request server-provided resource argument suggestions and explicitly watch resource changes without replacing attached snapshots.

Complete a template variable with a prefix, or an empty string to request initial suggestions:

```js
mcp_tools({
  complete: {
    server: "warehouse",
    template: "schema://tables/{table}",
    argument: { name: "table", value: "ev" }
  }
})
```

Completions can include known argument values for dependent suggestions. They never read resources or activate tools, and their output follows the existing size limits.

Use `/mcp subscribe warehouse schema://tables/events` to watch a resource, `/mcp subscriptions` to inspect watches, and `/mcp unsubscribe warehouse schema://tables/events` to stop watching. Updates show a change marker and a UI notification without fetching content or starting a model turn. Repeated updates coalesce until you unsubscribe.

Subscriptions require an interactive UI and support both legacy and modern servers. Watches are limited to 50 per server connection, stay in memory, and clear on branch or session changes, configuration reload, disconnection, and exit. They never resume automatically.

*By @mavam in #17.*

### Scoped MCP server configuration commands

You can now add and remove MCP servers without editing JSON. Both commands require an explicit global or project scope:

```text
/mcp add --scope global docs https://docs.mcp.cloudflare.com/mcp
/mcp add --scope project local -- node "/path with spaces/server.js"
/mcp remove --scope project local
```

Adding validates and saves the definition without starting a server, running secret commands, authenticating, or activating tools. Use `--replace` to replace an existing definition in the selected scope. Headers, environment overrides, and OAuth options are supported; put options before the server name.

Removal retains credentials and reports when a definition from the other scope remains effective. Changed or removed effective definitions lose their active tools. Project edits require a trusted project, and unrelated settings are preserved. Changes apply immediately in the current Pi session.

*By @mavam in #13.*

## 🔧 Changes

### Consistent MCP read and activation status rows

Resource reads and tool activation now use a compact operation header with one server-and-target status row per item, without repeating argument JSON. A checkmark marks successful reads and newly activated tools; a dot marks tools that were already active. Failed reads keep the resource URI beside a short error reason.

*By @mavam in #15.*

## 🐞 Bug fixes

### Explicit OAuth login opens authorization

Running `/mcp login <server>` now opens the authorization flow even when refresh tokens are already stored. Previously, explicit login could silently refresh the existing grant without opening the browser. Automatic token refresh during normal server use is unchanged.

*By @mavam in #12.*
