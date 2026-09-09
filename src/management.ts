import { line, plain, type CatalogTool } from "./catalog.js";
import { object, resolveServer, type ServerConfig } from "./config.js";
import { credentialStore, OAuthProvider, type CredentialStoreFactory } from "./auth.js";
import type { ServerStatus } from "./runtime.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

const serverStates = {
  disconnected: { glyph: "○", label: "idle" },
  connected: { glyph: "●", label: "connected" },
  connecting: { glyph: "▶︎", label: "connecting" },
  failed: { glyph: "✘︎", label: "error" },
  disabled: { glyph: "○", label: "disabled" },
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
export function oauthSettings(config: ServerConfig, cwd: string): { url: string; clientId?: string } {
  const resolved = resolveServer({ url: config.url, oauth: true, oauthClientId: config.oauthClientId }, cwd);
  return { url: resolved.url!, clientId: resolved.oauthClientId };
}

export async function authenticationSummary(
  config: ServerConfig,
  cwd: string,
  storeFactory: CredentialStoreFactory = credentialStore,
): Promise<string> {
  if (!config.oauth) return config.command
    ? "Server-managed (stdio)"
    : Object.keys(config.headers ?? {}).length
      ? "Headers (externally managed)"
      : "None configured";
  const method = config.oauthClientId === undefined ? "OAuth" : "OAuth (pre-registered public client)";
  try {
    const { url, clientId } = oauthSettings(config, cwd);
    const provider = new OAuthProvider(url, await storeFactory(url, clientId), undefined, clientId);
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
    `OAuth: ${config.oauth ? "enabled" : "disabled"}`,
    ...(config.oauth ? [
      `Requested scopes: ${config.oauthScopes?.map(line).join(", ") ?? "SDK/server defaults"}`,
      `OAuth callback: http://127.0.0.1:${config.oauthCallbackPort ?? 19847}/callback`,
    ] : []),
    ...(authentication ? [`Authentication: ${authentication}`] : []),
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
