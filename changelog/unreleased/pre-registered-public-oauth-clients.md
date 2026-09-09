---
title: Pre-registered public OAuth clients
type: feature
authors:
  - mavam
prs:
  - 12
created: 2026-09-09T05:47:53.752148Z
---

You can now connect to OAuth servers that require a pre-registered public client
instead of supporting dynamic registration. Set `oauth: true` and `oauthClientId`
in the server definition, then run `/mcp login <server>`:

```json
{
  "url": "https://mcp.example.com/mcp",
  "oauth": true,
  "oauthClientId": "${EXAMPLE_OAUTH_CLIENT_ID}"
}
```

Register the client with callback `http://127.0.0.1:19847/callback` and token
endpoint authentication method `none`. Client secrets are not supported.

Credentials are isolated by client ID, and successful grants stay bound to their
authorization-server issuer. Inspection identifies pre-registered clients without
printing the ID. Logout removes only credentials for the configured client.
