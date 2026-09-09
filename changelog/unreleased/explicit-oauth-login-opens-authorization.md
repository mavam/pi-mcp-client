---
title: Explicit OAuth login opens authorization
type: bugfix
authors:
  - mavam
prs:
  - 12
created: 2026-09-09T05:47:53.982943Z
---

Running `/mcp login <server>` now opens the authorization flow even when refresh
tokens are already stored. Previously, explicit login could silently refresh the
existing grant without opening the browser. Automatic token refresh during normal
server use is unchanged.
