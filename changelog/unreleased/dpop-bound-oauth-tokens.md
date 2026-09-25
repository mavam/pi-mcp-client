---
title: DPoP-bound OAuth tokens
type: feature
authors:
  - mavam
prs:
  - 33
created: 2026-09-25T11:44:35.795222Z
---

OAuth HTTP servers can now use DPoP proofs, which let a service bind access tokens to your client's signing key. Set `"oauthDpop": true` in the server definition, run `/mcp reload`, then `/mcp login example`. For a new server, use `/mcp add --scope global --oauth-dpop example https://mcp.example.com/mcp`.

ES256 signing keys are stored with OAuth credentials in the OS keyring and reused across connections and token refreshes. Missing or corrupt keys fail closed, and logout removes them. The service decides whether to issue bound tokens; Bearer tokens remain supported.
