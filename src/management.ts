import { line, plain, type CatalogTool } from "./catalog.js";
import { object, resolveServer, usesOAuth, type ServerConfig } from "./config.js";
import { credentialStore, OAuthProvider, type CredentialStoreFactory, type OAuthIdentity } from "./auth.js";
import type { ServerStatus } from "./runtime.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const serverStates = {
  disconnected: { glyph: "○", label: "idle", color: "muted" },
  connected: { glyph: "●", label: "connected", color: "success" },
  connecting: { glyph: "▶︎", label: "connecting", color: "warning" },
  failed: { glyph: "✘︎", label: "error", color: "error" },
  disabled: { glyph: "○", label: "disabled", color: "dim" },
} as const;

export function serverMatrix(
  servers: ServerStatus[],
  loaded: ReadonlyMap<string, number>,
  width = 80,
  theme?: Pick<Theme, "fg" | "bold">,
): string {
  if (width <= 0) return "";
  const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme ? theme.fg(color, text) : text;
  const bold = (text: string) => theme ? theme.bold(text) : text;
  const fit = (text: string) => {
    const fitted = truncateToWidth(text, width, "…");
    return theme ? fitted : plain(fitted);
  };
  const wrap = (text: string) => wrapTextWithAnsi(text, width).map(fit);
  const rows: string[] = [];
  if (!servers.length) return wrap(fg("muted", "No MCP servers configured.")).join("\n");

  const toolsWidth = Math.max(5, ...servers.map((server) => String(server.catalogSize ?? "—").length));
  const loadedWidth = Math.max(6, ...servers.map((server) => String(loaded.get(server.name) ?? 0).length));
  // Glyph + gaps + state + numeric columns. Reserve at least 12 cells for names.
  const fixedWidth = 18 + toolsWidth + loadedWidth;
  const compact = width < fixedWidth + 12;
  const nameWidth = Math.max(0, Math.min(40, width - fixedWidth,
    Math.max(6, ...servers.map(({ name }) => visibleWidth(line(name))))));
  const padName = (name: string) => {
    const text = plain(truncateToWidth(line(name), nameWidth, "…"));
    return text + " ".repeat(Math.max(0, nameWidth - visibleWidth(text)));
  };
  if (!compact) rows.push(fg("muted", bold(
    `  ${"Server".padEnd(nameWidth)}  ${"State".padEnd(10)}  ${"Tools".padStart(toolsWidth)}  ${"Loaded".padStart(loadedWidth)}`,
  )));
  for (const server of servers) {
    const state = serverStates[server.state];
    const count = loaded.get(server.name) ?? 0;
    const tools = String(server.catalogSize ?? "—");
    const name = fg(server.state === "disabled" ? "dim" : "text", bold(compact ? line(server.name) : padName(server.name)));
    const glyph = fg(state.color, state.glyph);
    if (compact) {
      rows.push(...wrap(`${glyph} ${name}`));
      rows.push(...wrap(`  ${fg(state.color, state.label)} · ${fg("muted", `${tools} tools · ${count} loaded`)}`));
    } else {
      rows.push(`${glyph} ${name}  ${fg(state.color, state.label.padEnd(10))}  ` +
        fg(server.catalogSize === undefined ? "dim" : "text", tools.padStart(toolsWidth)) + "  " +
        fg(count ? "accent" : "dim", String(count).padStart(loadedWidth)));
    }
  }
  rows.push("", ...wrap(fg("dim", "Connections open on demand. — = catalog not fetched.")));
  const errors = servers.filter((server) => server.state === "failed" && server.error);
  if (errors.length) rows.push("");
  for (const server of errors) {
    rows.push(...wrap(fg("error", `✘︎ ${line(server.name)}: [${line(server.error!.code)}]`) +
      fg("muted", ` ${line(server.error!.message)}`)));
  }
  return rows.map(fit).join("\n");
}

/** Pi's string selector uses two columns of padding and a two-column marker. */
export function toolPickerLabel(tool: CatalogTool, index: number, columns = 80): string {
  const width = Math.max(0, columns - 4);
  const text = `${index + 1}. ${line(tool.name)}: ${line(tool.description) || "No description."}`;
  return plain(truncateToWidth(text, width, "…"));
}

// These are display summaries, not validators; complex schemas stay authoritative.
function schemaType(schema: unknown, depth = 0): string {
  if (!object(schema) || depth > 2) return "unknown";
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    if (alternatives.length > 4) return "union";
    return [...new Set(alternatives.map((part) => schemaType(part, depth + 1)))].join(" | ") || "unknown";
  }
  if (schema.$ref || schema.allOf) return "unknown";
  const type = schema.type;
  if (Array.isArray(type))
    return type.slice(0, 4).map((part) => schemaType({ ...schema, type: part }, depth + 1)).join(" | ");
  if (type === "array") return `Array<${schemaType(schema.items, depth + 1)}>`;
  if (type === "integer") return "integer";
  if (["string", "number", "boolean", "object", "null"].includes(String(type))) return String(type);
  return "unknown";
}

function toolParameters(tool: CatalogTool) {
  const schema: unknown = tool.inputSchema;
  if (!object(schema)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(object(schema.properties) ? schema.properties : {}).map(([name, value]) => ({
    name: line(name).slice(0, 80),
    required: required.has(name),
    type: schemaType(value),
    description: object(value) && typeof value.description === "string" ? line(value.description) : "",
  }));
}

export function toolSignature(tool: CatalogTool, limit = 40): string {
  const parameters = toolParameters(tool);
  const args = parameters.slice(0, limit).map((parameter) =>
    `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.type}`,
  );
  if (parameters.length > limit) args.push(`… +${parameters.length - limit} more`);
  const schema: unknown = tool.inputSchema;
  if (object(schema) && schema.additionalProperties !== false) args.push("…");
  const name = line(tool.name).slice(0, 160);
  return args.length ? `${name}(\n${args.map((arg) => `  ${arg},`).join("\n")}\n)` : `${name}()`;
}

export function inspectTool(tool: CatalogTool): string {
  const parameters = toolParameters(tool);
  return [
    toolSignature(tool),
    line(tool.description) || "No description.",
    ...(parameters.length ? ["Parameters:"] : []),
    ...parameters.slice(0, 40).map((parameter) =>
      `${parameter.name}: ${parameter.type} (${parameter.required ? "required" : "optional"})${parameter.description ? `\n${parameter.description}` : ""}`,
    ),
    ...(parameters.length > 40 ? [`… ${parameters.length - 40} more parameters`] : []),
    "Types are summaries; the full schema may impose additional constraints.",
  ].join("\n\n");
}

/** Resolve only the credential identity, never headers or secret commands. */
export function oauthSettings(server: string, config: ServerConfig, cwd: string): OAuthIdentity {
  const resolved = resolveServer({ url: config.url, oauthClientId: config.oauthClientId }, cwd);
  return { server, url: resolved.url!, clientId: resolved.oauthClientId };
}

export async function authenticationSummary(
  server: string,
  config: ServerConfig,
  cwd: string,
  storeFactory: CredentialStoreFactory = credentialStore,
): Promise<string> {
  if (!usesOAuth(config)) return config.command
    ? "Server-managed (stdio)"
    : "Headers (externally managed)";
  const method = config.oauthClientId === undefined ? "OAuth" : "OAuth (pre-registered public client)";
  try {
    const identity = oauthSettings(server, config, cwd);
    const provider = new OAuthProvider(identity, await storeFactory(identity));
    return provider.tokens()
      ? `${method} · stored tokens (validity not checked)`
      : `${method} · no stored tokens`;
  } catch {
    return `${method} · credential status unavailable`;
  }
}

/** Never render connection values: credentials can occur in URLs, args, or commands. */
export function inspectServer(
  name: string,
  config: ServerConfig,
  status: string,
  authentication?: string,
): string {
  return [
    status,
    `Server: ${name}`,
    `Transport: ${config.command ? "stdio" : "HTTP"}`,
    `Protocol: ${config.protocol ?? "auto"}`,
    `OAuth: ${usesOAuth(config) ? "automatic" : "not used"}`,
    ...(usesOAuth(config) ? [
      `Requested scopes: ${config.oauthScopes?.map(line).join(", ") ?? "SDK/server defaults"}`,
      `OAuth callback: http://127.0.0.1:${config.oauthCallbackPort ?? 19847}/callback`,
    ] : []),
    ...(authentication ? [`Authentication: ${authentication}`] : []),
    `Timeout: ${config.timeoutMs ? `${config.timeoutMs} ms` : "default"}`,
    ...(config.startupTimeoutMs !== undefined ? [`Startup timeout: ${config.startupTimeoutMs} ms`] : []),
    ...(config.toolTimeoutMs !== undefined ? [`Tool timeout: ${config.toolTimeoutMs} ms`] : []),
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
