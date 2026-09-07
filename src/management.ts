import { line, plain } from "./catalog.js";
import type { ServerConfig } from "./config.js";
import type { ServerStatus } from "./runtime.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

const serverStates = {
  disconnected: { glyph: "○", label: "idle" },
  connected: { glyph: "✔︎", label: "connected" },
  connecting: { glyph: "▶︎", label: "connecting" },
  failed: { glyph: "✘︎", label: "error" },
  disabled: { glyph: "■", label: "disabled" },
} as const;

export function serverMatrix(
  servers: ServerStatus[],
  loaded: ReadonlyMap<string, number>,
  width = 80,
): string {
  if (width <= 0) return "";
  const fit = (text: string) => plain(truncateToWidth(text, width));
  if (!servers.length) return fit("No MCP servers configured.");
  const nameWidth = Math.min(40, Math.max(6, ...servers.map(({ name }) => name.length)));
  const heading = `  ${"Server".padEnd(nameWidth)}  ${"State".padEnd(10)}  ${"Tools".padStart(5)}  ${"Loaded".padStart(6)}`;
  const rows = servers.map((server) => {
    const state = serverStates[server.state];
    const name = plain(truncateToWidth(line(server.name), nameWidth)).padEnd(nameWidth);
    return `${state.glyph} ${name}  ${state.label.padEnd(10)}  ${String(server.catalogSize ?? "—").padStart(5)}  ${String(loaded.get(server.name) ?? 0).padStart(6)}`;
  });
  const errors = servers.filter((server) => server.state === "failed" && server.error)
    .map((server) => `✘︎ ${line(server.name)}: [${server.error!.code}] ${line(server.error!.message)}`);
  return [
    heading,
    ...rows,
    "",
    "Connections open on demand. — = catalog not fetched.",
    ...errors,
  ].map(fit).join("\n");
}

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
