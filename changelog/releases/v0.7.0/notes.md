Browse and open MCP prompts with one command: use /mcp prompt with a server name to browse, or add a prompt name to open it directly. This release removes the separate /mcp prompts command.

## 🔧 Changes

### One command for browsing and opening prompts

Use `/mcp prompt <server>` to browse prompts, or add a name and arguments to open one directly:

```text
/mcp prompt docs
/mcp prompt docs explain topic="OAuth flows"
```

The separate `/mcp prompts` command has been removed. Replace existing `/mcp prompts <server>` invocations with `/mcp prompt <server>`. Preview and confirmation behavior stays the same.

*By @mavam in #26.*
