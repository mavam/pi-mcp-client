MCP tool errors now use consistent error colors across discovery, activation, and native tool calls. This release preserves JSON syntax highlighting while making failure messages and details easier to distinguish.

## 🐞 Bug fixes

### Consistent error colors in MCP tool results

MCP tool errors now use the error color consistently for failure messages and details, rather than blue or muted text. This applies to discovery, activation, native tool calls, and argument validation. Successful results, warnings, and JSON syntax highlighting keep their existing colors.

*By @mavam in #8.*
