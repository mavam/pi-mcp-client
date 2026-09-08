---
title: Readable JSON in expanded MCP results
type: feature
authors:
  - mavam
prs:
  - 4
created: 2026-09-08T08:03:26.322938Z
---

Expanded MCP tool results now show JSON with indentation and syntax highlighting, making responses such as issue details easier to scan. JSON resource MIME types and structured content guide rendering; unlabeled JSON objects and arrays are detected automatically. Other formats and invalid, truncated, or oversized JSON stay plain text. The collapsed view and responses sent to the assistant are unchanged.
