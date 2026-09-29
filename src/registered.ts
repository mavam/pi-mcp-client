import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { object, parseConfig, resolveServer, type Config, type ServerConfig } from "./config.js";

/**
 * Translate a server that an extension registered with `pi.registerMcpServer()` into this
 * extension's configuration. Pi's `exposure` modes describe how the built-in extension reaches
 * tools; this extension always discovers, then activates, so only `hidden` has an equivalent.
 */
function translate(config: RegisteredMcpServer["config"]): unknown {
  const { exposure, toolExposure, enabled, timeout, oauth, type: _type, ...entry } =
    config as typeof config & { oauth?: unknown };
  const result: Record<string, unknown> = { ...entry };
  if (enabled === false) result.disabled = true;
  if (typeof timeout === "number") result.timeoutMs = Math.round(timeout * 1000);
  if (oauth !== undefined) {
    if (!object(oauth)) throw new Error("invalid oauth");
    if (oauth.clientSecret !== undefined || oauth.callbackUrl !== undefined)
      throw new Error("oauth.clientSecret and oauth.callbackUrl are not supported");
    if (oauth.clientId !== undefined) result.oauthClientId = oauth.clientId;
    if (typeof oauth.scope === "string") result.oauthScopes = oauth.scope.split(/\s+/).filter(Boolean);
    if (oauth.callbackPort !== undefined) result.oauthCallbackPort = oauth.callbackPort;
  }
  const overrides = Object.entries(toolExposure ?? {});
  if (exposure === "hidden") {
    const visible = overrides.filter(([, mode]) => mode !== "hidden").map(([name]) => name);
    if (visible.length) result.includeTools = visible;
    else result.disabled = true;
  } else {
    const hidden = overrides.filter(([, mode]) => mode === "hidden").map(([name]) => name);
    if (hidden.length) result.excludeTools = hidden;
  }
  return result;
}

/**
 * Add extension-registered servers to `configured`. A server from `mcp.json` wins over a
 * registration of the same name, as it does in Pi's built-in MCP support. Invalid registrations
 * are skipped and reported in `problems`.
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
      const parsed: ServerConfig | undefined = parseConfig(
        { mcpServers: { [server.name]: translate(server.config) } },
        `Registered MCP server ${server.name}`,
      )[server.name];
      if (!parsed) throw new Error("invalid definition");
      if (!parsed.disabled) resolveServer(parsed, cwd);
      extra[server.name] = parsed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid definition";
      problems.push(`Registered MCP server ${server.name} was skipped: ${reason.replace(/^Registered MCP server \S+: /, "")}`);
    }
  }
  return {
    config: Object.assign(Object.create(null), extra, configured) as Config,
    names: new Set(Object.keys(extra)),
    problems,
  };
}
