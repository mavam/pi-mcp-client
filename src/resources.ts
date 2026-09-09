import MiniSearch from "minisearch";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, line, plain, searchTools, tokens, type CatalogTool } from "./catalog.js";
import { object } from "./config.js";

export type DiscoveryKind = "all" | "tools" | "resources";
export interface ResourceTarget { server: string; uri: string }
export interface CatalogResource extends ResourceTarget {
  name: string;
  title?: string;
  description: string;
  mimeType?: string;
  size?: number;
  identity: string;
}
export type Candidate =
  | (CatalogTool & { kind: "tool"; nextCall: { activate: string[] } })
  | (CatalogResource & { kind: "resource"; nextCall: { read: ResourceTarget } });

/** URIs identify MCP resources; they are never fetched as URLs or opened as files. */
export function validResourceUri(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/u.test(value) &&
    !/[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function prepareResource(server: string, identity: string, value: unknown): CatalogResource {
  if (!object(value) || !validResourceUri(value.uri) ||
      typeof value.name !== "string" || !line(value.name) || value.name.length > 512 ||
      (value.title !== undefined && typeof value.title !== "string") ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.mimeType !== undefined && (typeof value.mimeType !== "string" || value.mimeType.length > 256)) ||
      (value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)))
    throw new Error("Invalid resource descriptor.");
  return {
    server, identity, uri: value.uri, name: plain(value.name),
    description: plain(value.description as string ?? "No description supplied.").slice(0, 8000),
    ...(value.title === undefined ? {} : { title: plain(value.title as string).slice(0, 512) }),
    ...(value.mimeType === undefined ? {} : { mimeType: line(value.mimeType as string) }),
    ...(value.size === undefined ? {} : { size: value.size as number }),
  };
}

/** One ranked result set and one limit, with executable next steps but no resource bodies. */
export function searchCapabilities(
  tools: CatalogTool[], resources: CatalogResource[], query: string,
  server?: string, limit = DEFAULT_SEARCH_LIMIT,
): Candidate[] {
  const toolCandidate = (tool: CatalogTool): Candidate => ({
    ...tool, kind: "tool", nextCall: { activate: [`${tool.server}.${tool.name}`] },
  });
  if (!resources.length) return searchTools(tools, query, server, limit).map(toolCandidate);
  const candidates: Candidate[] = [
    ...tools.map(toolCandidate),
    ...resources.map((resource): Candidate => ({
      ...resource, kind: "resource", nextCall: { read: { server: resource.server, uri: resource.uri } },
    })),
  ].filter((candidate) => !server || candidate.server === server);
  const needle = query.trim();
  const cap = Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
  const key = (candidate: Candidate) => JSON.stringify([candidate.kind, candidate.server,
    candidate.kind === "tool" ? candidate.name : candidate.uri]);
  const exact = candidates.filter((candidate) => candidate.kind === "resource"
    ? candidate.uri === needle
    : [candidate.nativeName, `${candidate.server}.${candidate.name}`].some((name) => name.toLowerCase() === needle.toLowerCase()));
  if (exact.length) return exact.sort((a, b) => key(a).localeCompare(key(b))).slice(0, cap);
  if (!tokens(query).length || !candidates.length) return [];
  const index = new MiniSearch({
    fields: ["name", "title", "description", "server", "uri"],
    tokenize: tokens,
    searchOptions: { boost: { name: 4, title: 4, description: 1, server: 1, uri: 2 }, prefix: true, combineWith: "OR" },
  });
  index.addAll(candidates.map((candidate) => ({ ...candidate, id: key(candidate) })));
  const byId = new Map(candidates.map((candidate) => [key(candidate), candidate]));
  return index.search(query).sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, cap).map((result) => byId.get(String(result.id))!);
}
