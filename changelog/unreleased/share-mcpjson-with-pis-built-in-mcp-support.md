---
title: Share mcp.json with Pi's built-in MCP support
type: breaking
authors:
  - mavam
created: 2026-09-29T17:58:09.744418Z
---

`mcp.json` now uses the shape of Pi's built-in MCP support, so the same file works with either extension. Rename these fields in your server definitions:

| Before | After |
| --- | --- |
| `disabled: true` | `enabled: false` |
| `includeTools`, `excludeTools` | `toolExposure` with `"hidden"` entries, or `exposure: "hidden"` plus `toolExposure` entries for an allowlist |
| `timeoutMs`, `startupTimeoutMs`, `toolTimeoutMs` | `timeout`, `startupTimeout`, `toolTimeout`, in seconds |
| `oauthClientId`, `oauthScopes`, `oauthCallbackPort`, `oauthDpop` | `oauth.clientId`, `oauth.scope` (space-separated), `oauth.callbackPort`, `oauth.dpop` |

`/mcp add`, `/mcp import`, and `/mcp disable` write the new shape. Options that only this extension knows (`description`, `startupTimeout`, `toolTimeout`, `protocol`, `oauth.dpop`) stay available, and `type: "streamable-http"` is accepted. Pi's `exposure` modes are accepted too, but only `hidden` has an effect because this extension always discovers and then activates tools.
