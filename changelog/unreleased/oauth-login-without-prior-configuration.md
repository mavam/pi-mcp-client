---
title: OAuth login without prior configuration
type: bugfix
authors:
  - mavam
created: 2026-09-09T12:21:25.111918Z
---

You can now add an HTTP server and sign in without enabling OAuth first:

```text
/mcp add --scope global slack https://mcp.slack.com/mcp
/mcp login slack
```

Login enables OAuth in the effective server definition and starts authorization. Other settings are preserved, and existing Authorization headers are never replaced. The OAuth setting remains enabled after a failed or cancelled login so you can retry. Authentication errors now point directly to the login command instead of requiring a manual configuration edit.
