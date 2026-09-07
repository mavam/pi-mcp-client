# pi-mcp-client

This repository contains **pi-mcp-client**, a pi extension for discovering MCP
tools on demand and calling them natively through the official MCP SDK.

See `README.md` for user-facing documentation.

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
- Keep model-facing discovery to one `mcp_search` tool. Search activates native
  tools cumulatively; do not add an invocation proxy or per-prompt schema dumps.
- Preserve unrelated tools and respect Pi's tool restrictions.
- Keep session state branch-local. Never persist credentials in session entries
  or catalog caches; OAuth credentials belong in the OS credential store.
- Keep renderers compact and width-safe, using Webfox-style status glyphs.
- Add tests for lifecycle changes, search activation, and error handling.
- Do not publish or push unless explicitly requested.

## Release engineering

- Use `tenzir-ship` for changelog management and releasing.
- Add changelog entries for user-visible changes with `uvx tenzir-ship add`.
- Before releasing, ensure `main` is in sync with `origin/main`.
- To release, dispatch `.github/workflows/release.yaml` with an intro and optional
  title. Publishing uses npm trusted publishing (OIDC), not an npm token.
