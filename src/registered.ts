import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { parseConfig, resolveServer, type Config } from "./config.js";

/**
 * Add servers that extensions registered with `pi.registerMcpServer()` to `configured`. They use
 * the `mcp.json` entry shape, so they go through the same validation. A server from `mcp.json`
 * wins over a registration of the same name, as it does in Pi's built-in MCP support. Invalid
 * registrations are skipped and reported in `problems`.
 */
export function withRegisteredServers(
  configured: Config,
  registered: readonly RegisteredMcpServer[],
  cwd: string,
): { config: Config; names: Set<string>; problems: string[] } {
  const extra: Config = Object.create(null);
  const problems: string[] = [];
  for (const server of registered) {
    if (Object.hasOwn(configured, server.name)) continue;
    try {
      const parsed = parseConfig({ mcpServers: { [server.name]: server.config } })[server.name];
      if (!parsed.disabled) resolveServer(parsed, cwd);
      extra[server.name] = parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message.replace(/^MCP configuration: /, "") : "invalid definition";
      problems.push(`Registered MCP server ${server.name} was skipped: ${reason}`);
    }
  }
  return {
    config: Object.assign(Object.create(null), extra, configured) as Config,
    names: new Set(Object.keys(extra)),
    problems,
  };
}
