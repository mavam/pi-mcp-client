---
title: Readable JSON in expanded MCP results
type: feature
authors:
  - mavam
prs:
  - 4
created: 2026-09-08T08:08:11.653639Z
---

Expanded MCP tool results now show JSON with indentation and syntax highlighting, making responses such as issue details easier to scan. JSON resource MIME types and structured content guide rendering; unlabeled JSON objects and arrays are detected automatically. Other formats and invalid, truncated, or oversized JSON stay plain text. Responses sent to the assistant are unchanged.

Argument-validation errors now show a compact status instead of repeating the entire error and argument payload. Expand the result to see the validation details once, followed by syntax-highlighted received arguments.
