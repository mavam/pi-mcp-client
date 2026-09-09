This release makes MCP authentication failures actionable and adds safe, previewable imports from Claude, Cursor, and Codex configurations. It also adds per-server OAuth accounts and interactive previews for server-provided prompts.

## 💥 Breaking changes

### Separate OAuth logins for named servers

Each named MCP server now has its own OAuth login, even when multiple servers use the same URL and client ID. You can keep personal and work accounts connected at the same time by giving them different server names:

```text
/mcp login cloudflare-personal
/mcp login cloudflare-work
```

Logging out removes only the selected named connection's local credentials and deactivates only its tools. Remote revocation behavior still depends on the service.

After upgrading, run `/mcp login <server>` again for each OAuth connection. Earlier credentials aren't migrated or deleted. Renaming a server also requires a new login; log out before renaming if you want to remove its old credentials. Definitions with the same name, URL, and client ID continue to share credentials across projects.

*By @mavam in #23.*

## 🚀 Features

### Previewable configuration imports

You can now import server definitions directly from Claude/Cursor JSON or Codex TOML instead of converting files or adding each connection by hand:

```text
/mcp import --scope global ~/.claude.json
/mcp import --scope global ~/.codex/config.toml
/mcp import --scope project "/path/to/mcp.json"
```

Claude files with project-specific servers offer a source-group chooser. Codex imports preserve disabled state, environment references, tool filters, and separate startup and tool-call timeouts, including Codex's defaults.

Review each server with connection values hidden, skip unsupported entries, and explicitly choose replacements or new names for conflicts. A final confirmation explains that inline credentials are copied with the selected definitions. The import saves all selected servers together without connecting, executing commands, or accessing another client's credential store. If the destination configuration changes during review, the import refuses to overwrite it.

Imports require an interactive TUI or RPC session and support stdio and Streamable HTTP connections. Unsupported connection options and approval policies are refused rather than silently discarded.

*By @mavam in #25.*

### User-selected MCP prompts with previews

You can now browse server-provided prompts, enter arguments, and review their resolved contents before sending them to the model:

```text
/mcp prompts docs
/mcp prompt docs explain topic="OAuth flows"
```

Only **Use prompt** starts a model turn. Browsing fetches metadata only, cancelling a preview leaves the conversation unchanged, and using a prompt doesn't activate tools or grant additional permissions. Text and embedded text resources are supported. Prompts with oversized or unsupported content are refused instead of being silently truncated or partially used.

The assistant can discover prompt metadata with `kind: "prompts"` and recommend a command, but prompt selection remains yours. Catalog notifications refresh metadata on the next discovery without changing previews or saved snapshots.

*By @mavam in #24.*

## 🐞 Bug fixes

### Actionable OAuth login diagnostics

OAuth login errors now explain missing client registration, rejected clients, scopes, grants, callback URLs, and unsupported PKCE or insecure token endpoints instead of reporting only a generic failure. For example, `/mcp login slack` without a registered client now points you to `oauthClientId` and the exact callback URL shown by `/mcp get slack`.

Unknown OAuth failures no longer suggest manual browser handoff as a universal fix. Error details remain private, and the authentication guide now explains Slack's registration and app requirements.

*By @mavam in #22.*
