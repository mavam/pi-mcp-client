---
title: Accurate client version reported to MCP servers
type: bugfix
authors:
  - mavam
prs:
  - 30
created: 2026-09-25T08:45:58.863276Z
---

MCP servers now see the installed Pi MCP Client version during connection setup. Previously, every release identified itself as version `0.1.0`, which made server-side logs and compatibility checks misleading.
