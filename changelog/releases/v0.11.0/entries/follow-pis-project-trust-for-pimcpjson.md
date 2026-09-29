---
title: Follow Pi's project trust for .pi/mcp.json
type: breaking
authors:
  - mavam
created: 2026-09-29T17:58:10.666148Z
---

Project servers now live in `.pi/mcp.json` instead of `.mcp.json`, and load whenever Pi trusts the project. Pi asks for trust itself when that file exists, remembers its answer, and honors `--approve`, `--no-approve`, and `defaultProjectTrust`, so this extension no longer shows its own trust dialog. Move project definitions to `.pi/mcp.json` and use Pi's `/trust` command to change a decision.
