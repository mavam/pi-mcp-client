import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { adaptCodexServer, CODEX_FIELDS } from "./codex-import.js";
import { commandWords } from "./config-commands.js";
import { ConfigMutationError, object, parseConfig, resolveServer, type ConfigScope, type ServerConfig } from "./config.js";

export const IMPORT_USAGE = "Usage: /mcp import --scope global|project <path>. Select and confirm servers interactively; no connections are opened.";
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_SERVERS = 100;
const FIELDS = new Set(["type", "command", "args", "cwd", "env", "url", "headers", "disabled", "description"]);
export const validImportName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(name);

export interface ImportCandidate {
  /** Invalid names are never displayed verbatim, but can be replaced in the picker. */
  name?: string;
  label: string;
  transport: "stdio" | "HTTP" | "unsupported";
  definition?: ServerConfig;
  problem?: string;
  escapedLiterals: boolean;
  group?: string;
}
export interface ImportSource {
  format: "json" | "codex";
  candidates: ImportCandidate[];
  ignoredTopLevel: number;
  groups?: string[];
}

export function parseImportCommand(input: string): { scope: ConfigScope; path: string } {
  const [action, flag, scope, path, ...extra] = commandWords(input);
  if (action !== "import" || flag !== "--scope" || (scope !== "global" && scope !== "project") ||
      !path || path.startsWith("--") || extra.length || /[\u0000-\u001f\u007f]/u.test(path))
    throw new ConfigMutationError(IMPORT_USAGE);
  return { scope, path };
}

/** Preserve foreign env/header literals instead of promoting ! or $VAR to Pi syntax. */
function escapeSecretLiteral(value: string): string {
  const escaped = value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$/gu, (match) => match === "$" ? "$$" : match);
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function hasUnsupportedTemplate(value: unknown): boolean {
  if (typeof value === "string")
    return /\$\{(?![A-Za-z_][A-Za-z0-9_]*\})|\$\{(?:workspaceFolder|workspaceFolderBasename|userHome|pathSeparator)\}/u.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedTemplate);
  if (object(value)) return Object.values(value).some(hasUnsupportedTemplate);
  return false;
}

/** Detect the file syntax, then adapt known MCP sections without loading client settings. */
export function parseImportSource(text: string): ImportSource {
  if (Buffer.byteLength(text, "utf8") > MAX_IMPORT_BYTES)
    throw new ConfigMutationError("Import file exceeds 1 MiB. Split it into smaller files.");
  let value: unknown;
  let format: ImportSource["format"] = "json";
  try { value = JSON.parse(text); }
  catch {
    try { value = parseToml(text, { integersAsBigInt: "asNeeded" }); format = "codex"; }
    catch { throw new ConfigMutationError("Import file is not valid JSON or TOML. JSON comments and trailing commas are not supported."); }
  }
  if (!object(value)) throw new ConfigMutationError("Expected an MCP configuration object.");
  const sections: { label: string; servers: Record<string, unknown> }[] = [];
  const key = format === "codex" ? "mcp_servers" : "mcpServers";
  if (Object.hasOwn(value, key)) {
    if (!object(value[key]) || value[key] instanceof Date)
      throw new ConfigMutationError("The MCP server section must be an object or table.");
    sections.push({ label: "Global servers", servers: value[key] });
  }
  if (format === "json" && object(value.projects)) {
    for (const [path, project] of Object.entries(value.projects)) {
      if (!object(project) || !Object.hasOwn(project, "mcpServers")) continue;
      if (!object(project.mcpServers)) throw new ConfigMutationError("A Claude project has an invalid mcpServers section.");
      if (Object.keys(project.mcpServers).length)
        sections.push({ label: `Project ${sections.length + 1}: ${JSON.stringify(path).slice(0, 120)}`, servers: project.mcpServers });
    }
  }
  if (!sections.length)
    throw new ConfigMutationError("Expected mcpServers in JSON, Claude projects with mcpServers, or mcp_servers in Codex TOML. VS Code and MCPorter formats are not supported.");
  const grouped = sections.some((section) => section.label !== "Global servers");
  const entries = sections.flatMap((section) => Object.entries(section.servers).map(([name, raw]) => ({ name, raw, group: grouped ? section.label : undefined })));
  if (entries.length > MAX_IMPORT_SERVERS)
    throw new ConfigMutationError("Import file exceeds 100 servers across its source groups. Split it into smaller files.");
  const candidates = entries.map(({ name, raw, group }, index): ImportCandidate => {
    const candidate: ImportCandidate = {
      name: validImportName(name) ? name : undefined,
      label: validImportName(name) ? name : `Entry ${index + 1} (requires a new name)`,
      transport: object(raw) && typeof raw.command === "string" ? "stdio"
        : object(raw) && typeof raw.url === "string" ? "HTTP" : "unsupported",
      escapedLiterals: false,
      ...(group ? { group } : {}),
    };
    if (!object(raw)) return { ...candidate, problem: "The server definition must be an object." };
    const unknown = Object.keys(raw).filter((key) => !(format === "codex" ? CODEX_FIELDS : FIELDS).has(key));
    if (unknown.length) return { ...candidate, problem: `${unknown.length} unsupported server field(s). Review the source file; this entry cannot be imported.` };
    if (raw.type !== undefined && raw.type !== "stdio" && raw.type !== "http")
      return { ...candidate, transport: "unsupported", problem: "Unsupported transport. Only stdio and Streamable HTTP can be imported; SSE is not converted." };
    try {
      const adapted = format === "codex" ? adaptCodexServer(raw) : { definition: raw, escapedLiterals: false };
      const definition = parseConfig({ mcpServers: { imported: adapted.definition } }).imported;
      candidate.escapedLiterals = adapted.escapedLiterals;
      if (format === "json" && hasUnsupportedTemplate(definition))
        return { ...candidate, problem: "Unsupported variable syntax. Only ${VAR} references are supported, without defaults or client-specific variables." };
      for (const field of ["env", "headers"] as const) {
        if (format === "codex" || !definition[field]) continue;
        definition[field] = Object.fromEntries(Object.entries(definition[field]).map(([key, value]) => {
          const escaped = escapeSecretLiteral(value);
          if (escaped !== value) candidate.escapedLiterals = true;
          return [key, escaped];
        }));
      }
      return { ...candidate, definition };
    } catch {
      return { ...candidate, problem: "Invalid or unsupported server settings, literal syntax, or conflicting options. Review the source file; this entry cannot be imported." };
    }
  });
  return {
    format, candidates,
    ignoredTopLevel: Object.keys(value).filter((field) => field !== key && !(grouped && field === "projects")).length,
    ...(grouped ? { groups: sections.map((section) => section.label) } : {}),
  };
}

/** Read a bounded snapshot of an explicitly named regular file, never a URL or stream. */
export async function readImportSource(path: string, cwd: string, signal?: AbortSignal): Promise<ImportSource & { path: string }> {
  let target = resolve(cwd, path.replace(/^~(?=\/|$)/u, homedir()));
  signal?.throwIfAborted();
  // O_NONBLOCK prevents an explicitly supplied FIFO from hanging before fstat.
  let file;
  try {
    target = await realpath(target);
    file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  }
  catch { throw new ConfigMutationError("Cannot open import file. Check the path and read permissions."); }
  try {
    if (!(await file.stat()).isFile()) throw new ConfigMutationError("Import source must be a regular file.");
    const bytes = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal?.throwIfAborted();
    if (size > MAX_IMPORT_BYTES) throw new ConfigMutationError("Import file exceeds 1 MiB. Split it into smaller files.");
    return { ...parseImportSource(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))), path: target };
  } catch (error) {
    if (error instanceof ConfigMutationError) throw error;
    signal?.throwIfAborted();
    throw new ConfigMutationError("Cannot read import file as UTF-8 JSON or TOML. Check its encoding and read permissions.");
  } finally { await file.close(); }
}

/** Resolve for validation only. Never save resolved secrets or expose validation errors. */
export function validateImportCandidate(candidate: ImportCandidate, cwd: string): string | undefined {
  if (candidate.problem) return candidate.problem;
  if (!candidate.definition) return "Invalid server definition.";
  try { resolveServer(candidate.definition, cwd); }
  catch { return "Cannot validate this connection. Check its URL, working directory, and required environment variables in Pi."; }
  return undefined;
}

export function importPreview(candidate: ImportCandidate, problem?: string): string {
  const definition = candidate.definition;
  return [
    `${candidate.label} · ${candidate.transport}`,
    ...(candidate.group ? [`Source: ${candidate.group}`] : []),
    ...(problem ? [problem] : []),
    ...(definition ? [
      "Connection values are hidden; review and trust the source file before importing.",
      `Arguments: ${definition.args?.length ?? 0}; environment: ${Object.keys(definition.env ?? {}).length}; headers: ${Object.keys(definition.headers ?? {}).length} (values hidden)`,
      `Imported state: ${definition.disabled ? "disabled" : "enabled; connections open on demand"}`,
      ...(definition.startupTimeoutMs !== undefined ? [`Startup timeout: ${definition.startupTimeoutMs} ms; tool timeout: ${definition.toolTimeoutMs} ms`] : []),
      ...(candidate.transport === "stdio" ? ["Relative paths use Pi's working directory, not the import file's directory."] : []),
      ...(candidate.escapedLiterals ? ["Env/header literals are escaped; only explicit source environment references expand."] : []),
    ] : []),
  ].join("\n");
}
