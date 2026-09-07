import { stripVTControlCharacters } from "node:util";
import MiniSearch from "minisearch";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { fingerprint, object } from "./config.js";

export interface CatalogTool {
  server: string;
  name: string;
  nativeName: string;
  description: string;
  inputSchema: TSchema;
  identity: string;
  schemaHash: string;
}

export function plain(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}
export function line(value: string): string {
  return plain(value).replace(/\s+/g, " ").trim();
}

export function nativeName(server: string, name: string): string {
  const base = `mcp__${server}__${name}`;
  if (
    /^[A-Za-z0-9_-]{1,64}$/.test(base) &&
    !server.includes("__") &&
    !name.includes("__")
  )
    return base;
  return `${base.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50)}__${fingerprint([server, name]).slice(0, 12)}`;
}

export function prepareTool(
  server: string,
  identity: string,
  tool: { name: string; description?: string; inputSchema: unknown },
): CatalogTool {
  if (
    !tool.name ||
    tool.name.length > 512 ||
    !object(tool.inputSchema) ||
    tool.inputSchema.type !== "object"
  )
    throw new Error("Invalid MCP tool name or input schema.");
  // Bound each schema before handing it to Pi's validator or a provider.
  const json = JSON.stringify(tool.inputSchema);
  if (Buffer.byteLength(json) > 64 * 1024)
    throw new Error("Tool schema exceeds 64 KiB.");
  const inputSchema = JSON.parse(json) as TSchema;
  Compile(inputSchema);
  return {
    server,
    name: tool.name,
    nativeName: nativeName(server, tool.name),
    identity,
    description: plain(tool.description ?? "No description supplied.").slice(0, 8000),
    inputSchema,
    schemaHash: fingerprint(inputSchema),
  };
}

const STOP = new Set([
  "a",
  "an",
  "the",
  "for",
  "to",
  "and",
  "in",
  "of",
  "with",
  "tool",
  "tools",
  "mcp",
]);
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 50;

function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((x) => x && !STOP.has(x));
}

/** Exact selectors win; ordinary retrieval weights names over descriptions. */
export function searchTools(
  tools: CatalogTool[],
  query: string,
  server?: string,
  limit = DEFAULT_SEARCH_LIMIT,
): CatalogTool[] {
  const candidates = tools.filter((tool) => !server || tool.server === server);
  const needle = query.trim().toLowerCase();
  const exact = candidates.find((tool) =>
    [tool.nativeName, `${tool.server}.${tool.name}`].some(
      (name) => name.toLowerCase() === needle,
    ),
  );
  if (exact) return [exact];
  if (!tokens(query).length || !candidates.length) return [];
  // Build from this discovery snapshot so refreshes and server filters cannot
  // leave stale tools in an independently cached search index.
  const index = new MiniSearch({
    fields: ["name", "description", "server"],
    idField: "nativeName",
    tokenize: tokens,
    searchOptions: {
      boost: { name: 4, description: 1, server: 1 },
      prefix: true,
      combineWith: "OR",
    },
  });
  index.addAll(candidates);
  const byName = new Map(candidates.map((tool) => [tool.nativeName, tool]));
  return index.search(query)
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT)))
    .map((result) => byName.get(result.id)!);
}
