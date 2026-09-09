# pi-mcp-client

A pi extension for discovering MCP tools on demand and calling them natively
through the official MCP SDK.

## Principles

- No backwards compatibility. Use semantic versioning for breaking changes.
- Keep the surface area minimal; remove superseded options and code paths.
- Keep protocol and transport behavior in the official MCP SDK.
- Checks run automatically on push. Don't run them manually unless investigating
  a reported failure.
- Don't push or publish unless requested.

## Documentation

Keep the README concise and user-facing. Update the relevant guide when behavior
changes:

- [Configuration](docs/configuration.md)
- [Authentication](docs/authentication.md)
- [Commands](docs/commands.md)
- [Tool reference](docs/tool-reference.md)
- [Behavior](docs/behavior.md)
- [Troubleshooting](docs/troubleshooting.md)

## Releases

Use `tenzir-ship` for changelog entries. Release through
`.github/workflows/release.yaml`.
