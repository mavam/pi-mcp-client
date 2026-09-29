Pi MCP Client now shares its mcp.json files and project trust with the MCP support built into Pi 0.99, so one configuration works with either. Activated tools also give codemode scripts the whole MCP result, and one invalid server no longer disables the others.

## 💥 Breaking changes

### Follow Pi's project trust for .pi/mcp.json

Project servers now live in `.pi/mcp.json` instead of `.mcp.json`, and load whenever Pi trusts the project. Pi asks for trust itself when that file exists, remembers its answer, and honors `--approve`, `--no-approve`, and `defaultProjectTrust`, so this extension no longer shows its own trust dialog. Move project definitions to `.pi/mcp.json` and use Pi's `/trust` command to change a decision.

*By @mavam.*

### Require Pi 0.99

This release requires Pi 0.99 or later, which changes how Pi declares tools that load during a session.

*By @mavam.*

### Share mcp.json with Pi's built-in MCP support

`mcp.json` now uses the shape of Pi's built-in MCP support, so the same file works with either extension. Rename these fields in your server definitions:

| Before                                                           | After                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `disabled: true`                                                 | `enabled: false`                                                                                             |
| `includeTools`, `excludeTools`                                   | `toolExposure` with `"hidden"` entries, or `exposure: "hidden"` plus `toolExposure` entries for an allowlist |
| `timeoutMs`, `startupTimeoutMs`, `toolTimeoutMs`                 | `timeout`, `startupTimeout`, `toolTimeout`, in seconds                                                       |
| `oauthClientId`, `oauthScopes`, `oauthCallbackPort`, `oauthDpop` | `oauth.clientId`, `oauth.scope` (space-separated), `oauth.callbackPort`, `oauth.dpop`                        |

`/mcp add`, `/mcp import`, and `/mcp disable` write the new shape. Options that only this extension knows (`description`, `startupTimeout`, `toolTimeout`, `protocol`, `oauth.dpop`) stay available, and `type: "streamable-http"` is accepted. Pi's `exposure` modes are accepted too, but only `hidden` has an effect because this extension always discovers and then activates tools.

*By @mavam.*

## 🚀 Features

### Give codemode scripts the whole MCP result

Activated MCP tools now cooperate with Pi's `codemode` tool. Scripts that call them receive the whole MCP result (`content`, `structuredContent`, and `isError`) instead of only its text, so they can call several tools in parallel and return just the parts the model needs. The server's `description` from `mcp.json` also appears above the tool group in the `codemode` description, and failed calls now report through Pi's native error results.

*By @mavam.*

### Work with Pi's built-in MCP support

Pi 0.99 introduced built-in MCP support, and this extension keeps replacing it when installed. Pi now prints a one-time warning about that replacement; disable `mcp` under Built-in in `pi config` to silence it.

Extensions that register servers with `pi.registerMcpServer()` now connect through this extension too. Servers in `mcp.json` take precedence, and registrations are never written to disk. Tools loaded through `mcp_tools` also join an `mcp__<server>` namespace and carry the annotations that servers declare, so permission extensions can confirm only calls that change something.

*By @mavam.*

## 🔧 Changes

### Skip invalid servers instead of failing the whole file

One invalid server no longer breaks the rest of your configuration. Invalid entries, such as an unknown field, an unsupported OAuth option, or a name this extension doesn't accept, are now skipped with a warning that names the server and the field. The other servers in the file still load, as in Pi's built-in MCP support. Files that share definitions with that support, for example through `pi mcp add`, no longer disable all your servers when one entry uses an option only the built-in extension understands. A file that isn't valid JSON, or that lacks an `mcpServers` object, still fails as a whole.

*By @mavam.*
