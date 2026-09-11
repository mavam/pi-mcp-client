# 🔌 Pi MCP Client

Connect Pi to MCP servers so the model can use their tools and read their
resources. You can also browse, preview, and use server-provided prompts.

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
question.

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
`.mcp.json`. Project definitions replace same-named global definitions in full.
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

- Pi 0.85.1 or later.
- Node.js 22 or later.
- The server executable for stdio connections.
- An available OS credential store for OAuth. Linux requires a working Secret
  Service/keyring session.

## 📄 License

[MIT](LICENSE)
