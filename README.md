# 🔌 Pi MCP Client

Connect Pi to MCP servers so the model can use their tools and read their
resources. You can also browse, preview, and use server-provided prompts.

> [!NOTE]
> On Pi **0.99.1 and later**, this extension is no longer needed for basic MCP
> use: Pi has built-in support for server tools, resources, and OAuth. Keep this
> extension if you need separate accounts at the same endpoint, OS-backed
> credential storage, or the additional features below.

## ⚖️ Do you need this extension?

Comparison with **Pi 0.99.2**.

| Feature | Built-in MCP | Pi MCP Client |
| --- | :---: | :---: |
| HTTP and stdio server tools | ✅ | ✅ |
| OAuth sign-in and token refresh | ✅ | ✅ |
| Tool namespaces and codemode calls | ✅ | ✅ |
| Resource listing, URI templates, and reads | ✅ | ✅ |
| [Separate OAuth accounts at the same endpoint](docs/authentication.md#use-multiple-accounts) | ❌ | ✅ |
| [OAuth credentials in the OS credential store](docs/authentication.md#sign-in-with-oauth) | ❌ | ✅ |
| [DPoP-bound OAuth tokens](docs/authentication.md#use-dpop-bound-tokens) | ❌ | ✅ |
| [Server prompts with preview before use](docs/commands.md#use-server-prompts) | ❌ | ✅ |
| [Resource argument completion](docs/tool-reference.md#complete-resource-arguments) | ❌ | ✅ |
| [Resource change watches](docs/commands.md#watch-resource-changes) | ❌ | ✅ |
| [Server requests for user input (elicitation)](docs/behavior.md#server-requests-for-input) | ❌ | ✅ |
| [Configuration imports with preview](docs/commands.md#import-server-definitions) | ❌ | ✅ |
| OAuth clients requiring a client secret | ✅ | ❌ |
| HTTP authentication with a provider's `/login` token | ✅ | ❌ |

Both read the same `mcp.json` files, but OAuth credentials don't transfer between
implementations. See
[switching to built-in MCP](docs/behavior.md#pis-built-in-mcp-support).
Built-in account isolation is tracked in
[upstream issue #10252](https://github.com/earendil-works/pi/issues/10252).

## 🚀 Installation

```sh
pi install npm:pi-mcp-client
```

## ✨ Usage

Start a new Pi session, then add Cloudflare's public documentation server:

```text
/mcp add --scope global cloudflare-docs https://docs.mcp.cloudflare.com/mcp
```

This server doesn't require credentials. Ask Pi:

> Search Cloudflare's documentation for how to deploy a Worker.

You configure servers and sign in when needed. The model finds and uses
relevant tools and resources—you don't need to select tools before asking a
question. When a server needs more information during a tool call, Pi asks you
directly and sends only what you submit. See
[server requests for input](docs/behavior.md#server-requests-for-input).

Use these commands in Pi to manage your connections:

| Command | Purpose |
| --- | --- |
| `/mcp` | Check connection status, available-tool counts, and tools loaded for the model when troubleshooting or checking your setup. |
| `/mcp login <server>` | Sign in to an HTTP server. Only this command opens the login browser. |
| `/mcp prompt <server> [name] [argument=value ...]` | Browse prompts or open one by name, then review a preview before using it. |
| `/mcp reload` | Apply changes after editing your MCP configuration files. |

Only configure servers you trust: local servers and secret commands run with your
permissions. Tool activation isn't a per-call approval prompt. See
[trust and permissions](docs/behavior.md#trust-and-permissions).

## ⚙️ Configuration

Store server definitions in `~/.pi/agent/mcp.json` or a trusted project's
`.pi/mcp.json`, the same files and shape as Pi's built-in MCP support. Project
servers load only in a project that Pi [trusts](docs/behavior.md#project-trust).
Project definitions replace same-named global definitions in full.
You can edit these files or use `/mcp add` and `/mcp remove`. To reuse a
Claude/Cursor JSON or Codex TOML file, run `/mcp import --scope global <path>` and
review the selected connections before saving.

Detailed guides:

- [Configuration](docs/configuration.md): HTTP and stdio servers, environment
  variables, secret commands, tool filters, and timeouts.
- [Authentication](docs/authentication.md): OAuth setup, pre-registered clients,
  remote login, and logout.
- [Commands](docs/commands.md): Server management, tool browsing, prompt selection,
  and resource watches. These are commands **you** run in Pi.
- [Tool reference](docs/tool-reference.md): Discovery, activation, resource reads,
  and argument completions. This is the **model's** interface, not a user API.
- [Behavior](docs/behavior.md): When servers connect, when tools become available,
  and what permissions they have.
- [Troubleshooting](docs/troubleshooting.md): Error codes, recovery, and large
  results.

## 🧰 Requirements

- Pi 0.99 or later.
- Node.js 22 or later.
- The server executable for stdio connections.
- An available OS credential store for OAuth. Linux requires a working Secret
  Service/keyring session.

## 📄 License

[MIT](LICENSE)
