import MiniSearch from "minisearch";
import { UriTemplate, type Variables } from "@modelcontextprotocol/client";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, line, plain, searchTools, tokens, type CatalogTool } from "./catalog.js";
import { promptCommand, type CatalogPrompt } from "./prompts.js";
import { object } from "./config.js";

export type DiscoveryKind = "all" | "tools" | "resources" | "prompts";
export interface ResourceTarget { server: string; uri: string }
export interface TemplateTarget { server: string; template: string; arguments: Variables }

export function validTemplateRead(value: Record<string, unknown>): boolean {
  if (value.uri !== undefined || !validTemplate(value.template) || !object(value.arguments)) return false;
  const entries = Object.entries(value.arguments);
  if (entries.length > 100) return false;
  if (!entries.every(([key, item]) => key.length <= 512 &&
    (typeof item === "string" ? item.length <= 4096 : Array.isArray(item) && item.length <= 100 &&
      item.every((v) => typeof v === "string" && v.length <= 4096)))) return false;
  if (Buffer.byteLength(JSON.stringify(value.arguments)) > 64 * 1024) return false;
  try { return validResourceUri(new UriTemplate(value.template).expand(value.arguments as Variables)); }
  catch { return false; }
}
export interface CompletionTarget {
  server: string;
  template: string;
  argument: { name: string; value: string };
  arguments?: Record<string, string>;
}

export function validCompletion(value: unknown): value is CompletionTarget {
  if (!object(value) || typeof value.server !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.server) ||
      !validTemplate(value.template) || !object(value.argument) ||
      typeof value.argument.name !== "string" || !value.argument.name || value.argument.name.length > 512 ||
      typeof value.argument.value !== "string" || value.argument.value.length > 4096 ||
      Object.keys(value.argument).some((key) => !["name", "value"].includes(key)) ||
      Object.keys(value).some((key) => !["server", "template", "argument", "arguments"].includes(key))) return false;
  if (value.arguments !== undefined && (!object(value.arguments) || Object.keys(value.arguments).length > 100 ||
      !Object.entries(value.arguments).every(([key, item]) => key.length <= 512 && typeof item === "string" && item.length <= 4096))) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 64 * 1024;
}

export interface CatalogResource extends ResourceTarget {
  name: string;
  title?: string;
  description: string;
  mimeType?: string;
  size?: number;
  identity: string;
  variables?: string[];
}
export type Candidate =
  | (CatalogTool & { kind: "tool"; nextCall: { activate: string[] } })
  | (CatalogResource & { kind: "resource"; nextCall: { read: ResourceTarget } })
  | (CatalogResource & { kind: "template"; nextCall: { read: TemplateTarget } })
  | (CatalogPrompt & { kind: "prompt"; command: string });

/** URIs identify MCP resources; they are never fetched as URLs or opened as files. */
export function validResourceUri(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 &&
    /^[A-Za-z][A-Za-z0-9+.-]*:\S*$/u.test(value) &&
    !/[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function prepareResource(server: string, identity: string, value: unknown): CatalogResource {
  if (!object(value) || !validResourceUri(value.uri)) throw new Error("Invalid resource URI.");
  return prepareDescriptor(server, identity, value, value.uri);
}

function prepareDescriptor(server: string, identity: string, value: Record<string, unknown>, uri: string): CatalogResource {
  if (typeof value.name !== "string" || !line(value.name) || value.name.length > 512 ||
      (value.title !== undefined && typeof value.title !== "string") ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.mimeType !== undefined && (typeof value.mimeType !== "string" || value.mimeType.length > 256)) ||
      (value.size !== undefined && (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)))
    throw new Error("Invalid resource descriptor.");
  return {
    server, identity, uri, name: plain(value.name),
    description: plain(value.description as string ?? "No description supplied.").slice(0, 8000),
    ...(value.title === undefined ? {} : { title: plain(value.title as string).slice(0, 512) }),
    ...(value.mimeType === undefined ? {} : { mimeType: line(value.mimeType as string) }),
    ...(value.size === undefined ? {} : { size: value.size as number }),
  };
}

function validTemplate(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  try { new UriTemplate(value); return true; } catch { return false; }
}

export function prepareResourceTemplate(server: string, identity: string, value: unknown): CatalogResource {
  if (!object(value) || !validTemplate(value.uriTemplate)) throw new Error("Invalid resource template.");
  const template = new UriTemplate(value.uriTemplate);
  // A template need not be absolute until expansion, e.g. {+base}/docs/{id}.
  return { ...prepareDescriptor(server, identity, value, value.uriTemplate), variables: template.variableNames };
}

/** One ranked result set and one limit, with executable next steps but no resource bodies. */
export function searchCapabilities(
  tools: CatalogTool[], resources: CatalogResource[], query: string,
  server?: string, limit = DEFAULT_SEARCH_LIMIT, templates: CatalogResource[] = [], prompts: CatalogPrompt[] = [],
): Candidate[] {
  const toolCandidate = (tool: CatalogTool): Candidate => ({
    ...tool, kind: "tool", nextCall: { activate: [`${tool.server}.${tool.name}`] },
  });
  if (!resources.length && !templates.length && !prompts.length) return searchTools(tools, query, server, limit).map(toolCandidate);
  const candidates: Candidate[] = [
    ...tools.map(toolCandidate),
    ...prompts.map((prompt): Candidate => ({ ...prompt, kind: "prompt", command: promptCommand(prompt) })),
    ...resources.map((resource): Candidate => ({
      ...resource, kind: "resource", nextCall: { read: { server: resource.server, uri: resource.uri } },
    })),
    ...templates.map((template): Candidate => ({
      ...template, kind: "template", nextCall: { read: { server: template.server, template: template.uri, arguments: {} } },
    })),
  ].filter((candidate) => !server || candidate.server === server);
  const needle = query.trim();
  const cap = Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT));
  const key = (candidate: Candidate) => JSON.stringify([candidate.kind, candidate.server,
    candidate.kind === "tool" || candidate.kind === "prompt" ? candidate.name : candidate.uri]);
  const exact = candidates.filter((candidate) => candidate.kind === "prompt"
    ? [candidate.name, `${candidate.server}.${candidate.name}`].some((name) => name.toLowerCase() === needle.toLowerCase())
    : candidate.kind !== "tool" ? candidate.uri === needle
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
