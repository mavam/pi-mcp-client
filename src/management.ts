import { line } from "./catalog.js";
import type { ServerConfig } from "./config.js";

/** Never render connection values: credentials can occur in URLs, args, or commands. */
export function inspectServer(
  name: string,
  config: ServerConfig,
  status: string,
): string {
  return [
    status,
    `Server: ${name}`,
    `Transport: ${config.command ? "stdio" : "HTTP"}`,
    `Protocol: ${config.protocol ?? "auto"}`,
    `OAuth: ${config.oauth ? "enabled" : "disabled"}`,
    `Timeout: ${config.timeoutMs ? `${config.timeoutMs} ms` : "default"}`,
    ...(config.command
      ? [
          "Command and working directory: hidden",
          `Arguments: ${config.args?.length ?? 0} (values hidden)`,
          `Environment overrides: ${Object.keys(config.env ?? {}).length} (names and values hidden)`,
        ]
      : [
          "URL: hidden",
          `Headers: ${Object.keys(config.headers ?? {}).length} (names and values hidden)`,
        ]),
    `Include tools: ${config.includeTools ? config.includeTools.map(line).join(", ") : "all"}`,
    `Exclude tools: ${config.excludeTools?.map(line).join(", ") || "none"}`,
  ].join("\n");
}
