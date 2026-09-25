This release closes a security gap: a project's .mcp.json now loads only after an explicit trust decision, so a freshly cloned repository can no longer start MCP server commands on its own.

## 🐞 Bug fixes

### Explicit trust decision for project MCP servers

A project's `.mcp.json` no longer loads in folders that Pi trusts only implicitly. Previously, a freshly cloned repository without Pi project resources could define MCP servers that ran local commands without any trust decision, even with `defaultProjectTrust` set to `never`.

In such folders, project servers now load only after an explicit decision:

- A decision saved with Pi's `/trust` command, for the folder or a parent folder, applies without asking.
- Otherwise, Pi's `defaultProjectTrust` setting applies: `always` loads project servers and `never` ignores them.
- With the default `ask`, interactive sessions show a trust prompt when a `.mcp.json` exists. Saved answers use Pi's project trust. Headless sessions ignore the file.

Folders with Pi project resources keep following Pi's own trust decision. To use project servers in a folder that is now ignored, choose **Trust** at the prompt, or run `/trust` and then `/mcp reload`.

*By @mavam in #29.*
