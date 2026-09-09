---
title: OAuth scopes, callback ports, and manual login
type: feature
authors:
  - mavam
prs:
  - 14
created: 2026-09-09T07:09:03.503984Z
---

You can now request OAuth scopes, choose a loopback callback port, and sign in from a remote Pi session without launching a browser on the Pi machine.

Use `/mcp login example --no-browser` to open an interactive dialog with an authorization URL. Complete sign-in in your browser, then paste the full callback URL into the dialog—not into chat. Manual login doesn't bind a local port and still requires an interactive UI and an OS credential store.

Set `oauthScopes` and `oauthCallbackPort` in the server definition, or supply them when adding a server:

```text
/mcp add --scope global --oauth --oauth-scope read --oauth-callback-port 19848 example https://mcp.example.com/mcp
```

Omitted scopes retain SDK/server defaults, and the default callback port remains 19847. Pre-registered clients must allow the configured callback URL. After changing options, reload MCP configuration and log in again. `/mcp get example` shows the requested scopes and callback address. The browser callback page now uses Pi's logo with a Pi MCP Client label and clear return-to-Pi guidance.
