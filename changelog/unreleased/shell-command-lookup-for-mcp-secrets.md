---
title: Shell command lookup for MCP secrets
type: feature
authors:
  - mavam
created: 2026-09-07T07:38:31.381091Z
---

You can now load MCP credentials from a password manager or another shell command instead of storing secrets in your configuration. Prefix an HTTP header or stdio environment value with `!`, for example:

```json
"env": {
  "API_TOKEN": "!op read 'op://Private/Example/token'"
}
```

Commands run when connecting, including reconnections, but not during configuration loading, status display, or cached discovery. Execution is time-limited and output-limited; failed commands stop the connection without disclosing command text or output. Resolved secrets are not stored in session records or catalog caches.

These fields also support Pi-style `$VAR` interpolation, `$$` for a literal dollar sign, and `$!` for a literal bang. Only a leading `!` in the original configuration triggers execution.
