---
title: Actionable OAuth login diagnostics
type: bugfix
authors:
  - mavam
created: 2026-09-09T14:23:39.888892Z
---

OAuth login errors now explain missing client registration, rejected clients, scopes, grants, callback URLs, and unsupported PKCE or insecure token endpoints instead of reporting only a generic failure. For example, `/mcp login slack` without a registered client now points you to `oauthClientId` and the exact callback URL shown by `/mcp get slack`.

Unknown OAuth failures no longer suggest manual browser handoff as a universal fix. Error details remain private, and the authentication guide now explains Slack's registration and app requirements.
