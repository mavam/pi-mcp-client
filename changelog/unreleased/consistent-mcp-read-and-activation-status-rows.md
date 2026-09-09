---
title: Consistent MCP read and activation status rows
type: change
authors:
  - mavam
prs:
  - 15
created: 2026-09-09T08:44:14.829782Z
---

Resource reads and tool activation now use a compact operation header with one server-and-target status row per item, without repeating argument JSON. A checkmark marks successful reads and newly activated tools; a dot marks tools that were already active. Failed reads keep the resource URI beside a short error reason.
