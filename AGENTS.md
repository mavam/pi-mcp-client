# pi-mcp-client

This repository contains **pi-mcp-client**, a pi extension for discovering MCP
tools on demand and calling them natively through the official MCP SDK.

## Documentation

- [README.md](README.md): Short human quickstart and guide index.
- [Configuration](docs/configuration.md): Server definitions, filters, secret commands, and reload behavior.
- [Authentication](docs/authentication.md): OAuth setup, credential lifecycle, and remote login.
- [Commands](docs/commands.md): Human-operated `/mcp` commands and resource watches.
- [Tool reference](docs/tool-reference.md): The assistant's `mcp_tools` interface and examples.
- [Behavior](docs/behavior.md): Sessions, caching, result display, trust, and permissions.
- [Troubleshooting](docs/troubleshooting.md): Diagnostics, recovery, and output limits.

Update the relevant guide when behavior changes. Keep the README concise and
human-facing; put model tool-call examples in the tool reference. Distinguish
what the user controls, what the assistant calls, and what the extension does.
Link to shared details rather than duplicating them across guides.

## Setup

Install dependencies with `bun install`, then install Lefthook once per clone:

```bash
uvx lefthook install
```

Pushing runs the quality gates automatically. To run them manually, use
`uvx lefthook run pre-push`.

## Development

- Use Bun: `bun install`, `bun run check`, and `bun run build`.
- Keep protocol and transport behavior in the official MCP SDK.
- Keep one model-facing `mcp_tools` tool: `{query, kind?, server?, limit?}` discovers
  tool and resource metadata (`kind` defaults to `all`); `{activate: ["server.tool"]}`
  explicitly activates exact identifiers cumulatively; `{read: {server, uri}}`
  fetches one resource as context. `{read: {server, template, arguments}}` expands
  an advertised template through the SDK before reading. Discovery never reads
  content or activates tools. Keep template parsing and expansion in the SDK;
  variable names don't imply an argument schema or required fields.
  `{complete: {server, template, argument: {name, value}, arguments?}}` requests
  server-provided template suggestions without reading or activating anything.
  Resource subscriptions are user-only `/mcp subscribe|unsubscribe` commands;
  keep watches memory-only, coalesce change notifications, never fetch content
  automatically, and clear watches on branch/session changes and disconnects.
  Keep native tool invocation; do not add an invocation proxy or per-prompt schema dumps.
- Validate mutually exclusive query/activation/read/completion arguments before connecting.
  Persist discovery as `details.candidates`; only activation writes `details.loaded`.
- Route resource reads only through the owning MCP server. Never fetch resource
  URIs as local files or generic URLs, follow content links automatically, or
  replay reads during session restoration. Keep resource catalog caches memory-only
  and reads uncached; treat content as untrusted data and bound model-facing output.
- Preserve unrelated tools and respect Pi's tool restrictions.
- Keep session state branch-local. Never persist credentials in session entries
  or catalog caches; OAuth credentials belong in the OS credential store.
- Keep renderers compact and width-safe, using Webfox-style status glyphs.
- Add tests for lifecycle changes, discovery/activation separation, and error handling.
- Do not publish or push unless explicitly requested.

## Release engineering

- Use `tenzir-ship` for changelog management and releasing.
- Add changelog entries for user-visible changes with `uvx tenzir-ship add`.
- Before releasing, ensure `main` is in sync with `origin/main`.
- To release, dispatch `.github/workflows/release.yaml` with an intro and optional
  title. Publishing uses npm trusted publishing (OIDC), not an npm token.
