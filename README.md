# 🔌 Pi MCP Client

Connect Pi to MCP servers. The assistant discovers tools and resources on demand,
reads resources as context, and calls tools natively through the official
TypeScript SDK. No bridge process or invocation proxy.

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

You configure servers and manage authentication. The assistant discovers
capabilities, reads resources, and activates tools as needed. You don't need to
type tool calls or select tools before asking a question.

Use these commands in Pi to manage your connections:

| Command | Purpose |
| --- | --- |
| `/mcp` | Inspect server status and loaded-tool counts. Idle connections are normal; servers connect on demand. |
| `/mcp login <server>` | Sign in to an OAuth-enabled server. Only this command opens the login browser. |
| `/mcp reload` | Apply changes after editing your MCP configuration files. |

Only configure servers you trust: local servers and secret commands run with your
permissions. Tool activation isn't a per-call approval prompt. See
[trust and permissions](docs/behavior.md#trust-and-permissions).

## ⚙️ Configuration

Store server definitions in `~/.pi/agent/mcp.json` or a trusted project's
`.mcp.json`. Project definitions replace same-named global definitions in full.
You can edit these files or use `/mcp add` and `/mcp remove`.

Detailed guides:

- [Configuration](docs/configuration.md): HTTP and stdio servers, environment
  variables, secret commands, tool filters, and timeouts.
- [Authentication](docs/authentication.md): OAuth setup, pre-registered clients,
  remote login, and logout.
- [Commands](docs/commands.md): Server management, tool browsing, and resource
  watches. These are commands **you** run in Pi.
- [Tool reference](docs/tool-reference.md): Discovery, activation, resource reads,
  and argument completions. This is the **assistant's** interface, not a user API.
- [Behavior](docs/behavior.md): Sessions, caching, result display, and permissions.
- [Troubleshooting](docs/troubleshooting.md): Error codes, recovery, and large
  results.

## 🧰 Requirements

- Pi 0.85.1 or later, with additive dynamic tool loading.
- Node.js 22 or later.
- The server executable for stdio connections.
- An available OS credential store for OAuth. Linux requires a working Secret
  Service/keyring session.

## 🧹 Uninstall

```sh
pi remove npm:pi-mcp-client
```

## 📄 License

[MIT](LICENSE)
