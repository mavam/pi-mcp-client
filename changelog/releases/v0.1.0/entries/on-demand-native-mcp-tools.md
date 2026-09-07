---
title: Introducing Pi MCP Client
type: feature
authors:
  - mavam
created: 2026-09-07T07:08:06.936079Z
---

Pi MCP Client brings Model Context Protocol (MCP) tools to Pi, with on-demand discovery and native tool calls instead of an invocation proxy. Connect your existing MCP servers to give Pi access to documentation, issue trackers, and other services without loading every tool schema upfront.

Search uses BM25-based ranking to account for term rarity and description length, with stronger weighting for tool names and support for prefix matching. Exact tool selectors bypass ranking. Search parameters describe the supported limit of 1–50 tools (default: 5) and encourage focused queries. Search results display each tool once with a short `server.tool` name; expanding adds a one-line description without repeating the model-facing response. Warnings and failures remain visible. Running indicators use a muted color, reserving warning colors for actual problems.

Pi discovers the tools it needs as you work. Use `mcp_search({ query: "search issues", server: "linear" })` to load matching tools; they remain available as the conversation continues and are restored when you resume or navigate branches.

Connect local stdio servers or remote Streamable HTTP servers, authenticate with bearer headers or `/mcp auth <server>`, and inspect progress through compact status glyphs. Server filters control which tools can be loaded, and large results are saved to private temporary files.

Configure connections in `~/.pi/agent/mcp.json` using the common `mcpServers` format. Explicit `type: "stdio"` and `type: "http"` tags are supported; omit `type` to infer it from `command` or `url`. Protocol-version negotiation is automatic by default; set `"protocol": "legacy"` only when a server needs an explicit legacy handshake. Put Pi-specific options directly in each server definition, for example:

```json
{
  "mcpServers": {
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "oauth": true,
      "includeTools": ["search_*"]
    }
  }
}
```
