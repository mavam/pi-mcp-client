OAuth authentication is more secure and predictable. The client now supports DPoP-bound tokens, requires explicit approval for additional permissions, and handles connection failures and cancellation more reliably.

## 🚀 Features

### DPoP-bound OAuth tokens

OAuth HTTP servers can now use DPoP proofs, which let a service bind tokens to your client's signing key. Set `"oauthDpop": true` in the server definition, run `/mcp reload`, then `/mcp login example`. For a new server, use `/mcp add --scope global --oauth-dpop example https://mcp.example.com/mcp`.

ES256 signing keys are stored with OAuth credentials in the OS keyring and reused across connections and token refreshes. Missing or corrupt keys fail closed, and logout removes them. Login detects unusable signing-key state before opening the browser; if you intentionally disabled DPoP, log out before obtaining a fresh grant. Repeated requests reuse loaded keys while still checking whether credentials changed.

The service decides whether to issue bound access tokens; Bearer access tokens remain supported, including with bound refresh tokens. Key loss doesn't permit proof-less refresh or silently trust a replacement issuer. Switching issuers requires explicit logout before signing in again.

*By @mavam in #33.*

### Explicit approval for additional OAuth permissions

When an MCP server requires additional OAuth permissions, the operation now stops with a request to review them. Run `/mcp login example` to page through the requested scope names and approve a fresh login that retains configured and known previously granted scopes, including when subsequent token responses omit scope information.

If the previous grant's scopes are unknown, the review warns that its permissions might not be retained. Configure `oauthScopes` with the permissions you need rather than relying on unspecified service defaults. After review, sign-in dialogs show a scope count instead of repeating long permission lists.

Declining or cancelling sign-in leaves your existing grant unchanged. Reloading configuration cancels active sign-in. No browser opens until you approve, and signing in never replays the rejected operation. Scope requests expire after ten minutes and aren't saved across sessions or configuration reloads.

*By @mavam in #32.*

## 🐞 Bug fixes

### More reliable OAuth connections and cancellation

OAuth connections now report credential-store failures after token refresh instead of silently starting another login. Connections also handle exact OAuth resource identifiers and request cancellation more reliably. Authentication recovery keeps remote error details out of terminal warnings.

*By @mavam in #31.*
