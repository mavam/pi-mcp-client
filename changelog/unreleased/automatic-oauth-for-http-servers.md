---
title: Automatic OAuth for HTTP servers
type: change
authors:
  - mavam
prs:
  - 19
created: 2026-09-09T12:38:32.886454Z
---

HTTP servers now detect OAuth requirements automatically and reuse stored credentials without an `oauth` flag. Add a server by URL, then sign in when needed:

```text
/mcp add --scope global slack https://mcp.slack.com/mcp
/mcp login slack
```

Login no longer changes configuration files. Existing Authorization headers take precedence, and only explicit login can register an OAuth client or open a browser. Public servers remain usable when the OS credential store is unavailable.

Existing `"oauth": true` settings still work; `"oauth": false` disables automatic OAuth. Client IDs, scopes, and callback ports no longer require `--oauth`. The optional `type` field remains inferred from `url` or `command`, so minimal HTTP definitions need only a URL.
