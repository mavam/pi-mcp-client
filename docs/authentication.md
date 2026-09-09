# Authentication

[Back to the README](../README.md)

You manage authentication through `/mcp login` and `/mcp logout`. The assistant
can't initiate an OAuth login: only your explicit login command opens the browser.
For externally managed bearer tokens, use
[headers and secret commands](configuration.md#secret-commands) instead.

## Sign in with OAuth

Add the HTTP server, then log in:

```text
/mcp add --scope global example https://mcp.example.com/mcp
/mcp login example
```

Replace the example URL with your server's URL. This flow requires dynamic
client registration or a [pre-registered public client](#use-a-pre-registered-client).
Adding a URL alone isn't enough for servers such as Slack.

Login uses the effective server definition (the trusted project override, if
present; otherwise the global definition) and starts the SDK's OAuth discovery
and authorization flow. It doesn't change configuration files. Adding a server
still doesn't connect or open a browser.

HTTP servers use automatic authentication by default:

- Configured Authorization headers take precedence over OAuth.
- Otherwise, connections reuse stored OAuth tokens when available. The SDK
  handles authentication challenges and refreshes existing grants.
- Without a grant, an authentication challenge asks you to run `/mcp login`.
  Discovery and tool calls never register a new client or open a browser.
- A missing or locked keyring doesn't block public servers. If the server
  requires OAuth, an unavailable keyring is an error; no credentials are stored
  outside the OS credential store.

The `oauth` configuration field and `--oauth` switch aren't supported. Remove
these from existing definitions and commands; HTTP authentication is automatic.

If the server uses an Authorization header, login asks you to remove that header
before switching to OAuth; it never replaces existing header credentials.
Stdio servers manage their own authentication and don't support OAuth login.

The extension supports public clients with dynamic registration or a
pre-registered client ID. Both use PKCE and a loopback callback at
`http://127.0.0.1:19847/callback` by default. Normal login opens a local listener
that your browser must be able to reach.

Authentication times out after two minutes; you can cancel it with Escape in the
terminal UI. Explicit login always starts a fresh authorization flow, even if a
refresh token is already stored. The browser callback page identifies **Pi MCP
Client** and asks you to return to Pi; receiving a callback doesn't yet mean the
token exchange succeeded.

OAuth tokens and client registrations are stored in the operating system
credential store, bound to the server URL, configured client ID (if any), and
authorization-server issuer. There is no plaintext credential fallback. PKCE
verifiers and callback state stay in memory. Linux requires a working Secret
Service/keyring session.

### Upgrade from earlier versions

Credentials now use an identity based only on the server URL and optional client
ID. Earlier credential-store entries aren't migrated or deleted. Run
`/mcp login <server>` again after upgrading; revoke old grants at the service if
needed. Changing scopes or the callback port doesn't select a different store.

## Use a pre-registered client

For a server without dynamic registration, register a **public/native** client
with the service, using the exact callback URL and token endpoint authentication
method `none`. Then configure its client ID:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauthClientId": "${EXAMPLE_OAUTH_CLIENT_ID}"
    }
  }
}
```

Run `/mcp reload`, then `/mcp login example`. The configured ID is used for login,
token refresh, and revocation; the extension never falls back to dynamic
registration if it is rejected. `/mcp get example` identifies the client as
pre-registered without printing the ID.

Changing the client ID selects separate credentials and requires a new login.
Log out before changing or removing the ID if you want to delete its old
credentials. After the first successful grant, a pre-registered client is pinned
to its authorization-server issuer. If that issuer changes, verify the server
configuration before logging out and logging in again to trust the replacement.

### Slack setup requirements

[Slack doesn't support dynamic client registration](https://docs.slack.dev/ai/slack-mcp-server/).
Without a registered client, login fails before opening a browser. Configure
`oauthClientId` with your Slack app's client ID, and ensure the app supports
public-client PKCE. Apps requiring a client secret aren't supported by this
extension. Slack also requires an eligible internal or Marketplace-published
app and any workspace administrator approval required by your workspace.

Register the exact callback URL shown by `/mcp get slack` in the app settings
(default: `http://127.0.0.1:19847/callback`). For example:

```json
{
  "mcpServers": {
    "slack": {
      "url": "https://mcp.slack.com/mcp",
      "oauthClientId": "${SLACK_OAUTH_CLIENT_ID}"
    }
  }
}
```

Set the environment variable before starting Pi. Run `/mcp reload`, then
`/mcp login slack`. A configured ID appears as **OAuth (pre-registered public
client)** in `/mcp get slack`; the ID itself stays hidden. A client ID alone
doesn't guarantee that the app permits this login flow or callback address.
`--no-browser` doesn't fix registration or app-approval problems.

## Set scopes and callback ports

Configure scopes and a callback port in the server definition:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauthScopes": ["read", "write"],
      "oauthCallbackPort": 19848
    }
  }
}
```

Or set them when adding the server:

```text
/mcp add --scope global --oauth-scope read --oauth-scope write --oauth-callback-port 19848 example https://mcp.example.com/mcp
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

## Sign in remotely or without launching a browser

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

Manual login doesn't open a browser or bind a callback port. The extension
validates the callback address, state, and authorization response before
exchanging the code. It doesn't write authorization URLs or pasted callbacks to
session entries, catalogs, notifications, or logs. Treat the callback URL as
sensitive; your browser history and clipboard may still contain it.

`--no-browser` still requires an interactive UI and an available OS credential
store. It isn't unattended authentication: print and JSON modes refuse OAuth
login. Use externally managed bearer headers for unattended access. Confidential
clients requiring a client secret aren't supported yet.

## Sign out

Run `/mcp logout <server>` to remove stored tokens and client registrations. Logout
also closes connections and deactivates tools for OAuth servers sharing
the same URL and configured client ID, since they share credentials. Configuration
and enabled state stay unchanged. Disabled servers accept logout too. Header and
server-managed credentials remain untouched.

Local removal happens before a bounded attempt to revoke tokens at the original
authorization server. The result distinguishes accepted revocation, unsupported
revocation, and unconfirmed revocation. When revocation isn't confirmed, remove the
grant at the service if needed. Repeating logout is safe. Other running Pi sessions
may need to reconnect; logout cannot recall requests already sent to a server.

Removing a server definition doesn't remove its credentials. Log out before
[removing the definition](commands.md#add-and-remove-servers) if you want both.
