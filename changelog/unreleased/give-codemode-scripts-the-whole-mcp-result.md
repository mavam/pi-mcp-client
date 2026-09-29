---
title: Give codemode scripts the whole MCP result
type: feature
authors:
  - mavam
created: 2026-09-29T18:04:03.379385Z
---

Activated MCP tools now cooperate with Pi's `codemode` tool. Scripts that call them receive the whole MCP result (`content`, `structuredContent`, and `isError`) instead of only its text, so they can call several tools in parallel and return just the parts the model needs. The server's `description` from `mcp.json` also appears above the tool group in the `codemode` description, and failed calls now report through Pi's native error results.
