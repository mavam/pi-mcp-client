---
title: DPoP-bound OAuth tokens
type: feature
authors:
  - mavam
prs:
  - 33
created: 2026-09-25T11:51:56.120643Z
---

OAuth HTTP servers can now use DPoP proofs, which let a service bind tokens to your client's signing key. Set `"oauthDpop": true` in the server definition, run `/mcp reload`, then `/mcp login example`. For a new server, use `/mcp add --scope global --oauth-dpop example https://mcp.example.com/mcp`.

ES256 signing keys are stored with OAuth credentials in the OS keyring and reused across connections and token refreshes. Missing or corrupt keys fail closed, and logout removes them. The service decides whether to issue bound access tokens; Bearer access tokens remain supported, including with bound refresh tokens. Key loss doesn't permit proof-less refresh or silently trust a replacement issuer. Switching issuers requires explicit logout before signing in again.
