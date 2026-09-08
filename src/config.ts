import { chmod, readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { secretTemplate } from "./secrets.js";

export interface ClientOptions {
  description?: string;
  oauth?: boolean;
  disabled?: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
  protocol?: "legacy" | "auto";
}

/** Normalized runtime configuration; explicit transport tags are validated, then inferred. */
export interface ServerConfig extends ClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export type Config = Record<string, ServerConfig>;

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OPTION_FIELDS = [
  "description",
  "oauth",
  "disabled",
  "includeTools",
  "excludeTools",
  "timeoutMs",
  "protocol",
] as const;

function validateOptions(
  entry: Record<string, unknown>,
  fail: (field: string) => never,
): void {
  if (
    entry.description !== undefined &&
    (typeof entry.description !== "string" || !entry.description)
  )
    fail("description");
  for (const key of ["includeTools", "excludeTools"]) {
    if (
      entry[key] !== undefined &&
      (!Array.isArray(entry[key]) ||
        !entry[key].every((x: unknown) => typeof x === "string"))
    )
      fail(key);
  }
  for (const key of ["oauth", "disabled"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "boolean") fail(key);
  }
  if (
    entry.timeoutMs !== undefined &&
    (!Number.isInteger(entry.timeoutMs) ||
      Number(entry.timeoutMs) < 100 ||
      Number(entry.timeoutMs) > 600_000)
  )
    fail("timeoutMs (100–600000)");
  if (
    entry.protocol !== undefined &&
    entry.protocol !== "legacy" &&
    entry.protocol !== "auto"
  )
    fail("protocol");
}

function parseConnections(value: unknown, source: string): Config {
  if (!object(value) || !object(value.mcpServers)) {
    throw new Error(`${source}: expected an mcpServers object.`);
  }
  if (Object.hasOwn(value, "pi"))
    throw new Error(`${source}: the pi section is not supported. Put server options directly in mcpServers.<server>.`);
  const result: Config = Object.create(null);
  const fields = new Set([
    "type",
    "command",
    "args",
    "cwd",
    "env",
    "url",
    "headers",
    ...OPTION_FIELDS,
  ]);
  for (const [name, entry] of Object.entries(value.mcpServers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name) || !object(entry)) {
      throw new Error(`${source}: invalid server name or definition.`);
    }
    const fail = (field: string): never => {
      throw new Error(`${source}: invalid ${field} for server ${name}.`);
    };
    for (const key of Object.keys(entry)) if (!fields.has(key)) fail(key);
    validateOptions(entry, fail);
    if (entry.type !== undefined && entry.type !== "stdio" && entry.type !== "http")
      fail("type (supported transports: stdio, http; SSE is not supported)");
    for (const key of ["command", "cwd", "url"]) {
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key]))
        fail(key);
    }
    for (const key of ["args"]) {
      if (
        entry[key] !== undefined &&
        (!Array.isArray(entry[key]) ||
          !entry[key].every((x: unknown) => typeof x === "string"))
      )
        fail(key);
    }
    for (const key of ["env", "headers"]) {
      if (
        entry[key] !== undefined &&
        (!object(entry[key]) ||
          !Object.values(entry[key]).every((x) => typeof x === "string"))
      )
        fail(key);
    }
    if (Boolean(entry.command) === Boolean(entry.url))
      fail("transport (provide exactly one of command or url)");
    if (
      (entry.type === "stdio" && !entry.command) ||
      (entry.type === "http" && !entry.url)
    )
      fail("type (must match command or url)");
    if (entry.command && (entry.oauth || entry.headers))
      fail("HTTP options on stdio transport");
    if (entry.url && (entry.args || entry.cwd || entry.env))
      fail("stdio options on HTTP transport");
    const { type: _type, ...normalized } = entry;
    result[name] = structuredClone(normalized) as unknown as ServerConfig;
  }
  return result;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function parseConfig(value: unknown, source = "MCP configuration"): Config {
  return parseConnections(value, source);
}

/** Project server definitions replace global definitions in full, including options. */
export async function loadConfig(
  agentDir: string,
  cwd: string,
  trusted: boolean,
): Promise<Config> {
  let config: Config = Object.create(null);
  const paths = [
    join(agentDir, "mcp.json"),
    ...(trusted ? [join(cwd, ".mcp.json")] : []),
  ];
  for (const path of paths) {
    const value = await readJson(path);
    if (value === undefined) continue;
    config = Object.assign(config, parseConfig(value, path));
  }
  return config;
}

/** Update only the effective definition, preserving unresolved secrets and other fields. */
export async function setServerDisabled(
  agentDir: string,
  cwd: string,
  trusted: boolean,
  server: string,
  disabled: boolean,
  validate: (config: Config) => void,
): Promise<{ config: Config; scope: "project" | "global" }> {
  const paths = [join(agentDir, "mcp.json"), ...(trusted ? [join(cwd, ".mcp.json")] : [])];
  // Deduplicate aliases and lock in a stable order for the whole read/modify/write.
  const locks = [...new Set(await Promise.all(
    paths.map((path) => realpath(path).catch(() => resolve(path))),
  ))].sort();
  const locked = async (index: number): Promise<{ config: Config; scope: "project" | "global" }> => {
    if (index < locks.length)
      return withFileMutationQueue(locks[index], () => locked(index + 1));
    const documents = await Promise.all(paths.map(readJson));
    const config: Config = Object.create(null);
    let source = -1;
    for (const [index, document] of documents.entries()) {
      if (document === undefined) continue;
      const parsed = parseConfig(document, paths[index]);
      Object.assign(config, parsed);
      if (Object.hasOwn(parsed, server)) source = index;
    }
    if (source < 0) throw new Error("Server is no longer configured. Run /mcp reload.");
    const changed = Boolean(config[server].disabled) !== disabled;
    if (changed) config[server].disabled = disabled;
    validate(config);
    const document = documents[source] as { mcpServers: Record<string, ServerConfig> };
    if (changed) {
      document.mcpServers[server].disabled = disabled;
      // Follow symlinks without replacing them. Stage privately, then atomically replace.
      const target = await realpath(paths[source]);
      const mode = (await stat(target)).mode & 0o777;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        // Preserve permissions only after the complete document is on disk.
        await chmod(temporary, mode);
        validate(config);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { config, scope: source === 0 ? "global" : "project" };
  };
  return locked(0);
}

export function interpolate(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) throw new Error(`Missing environment variable: ${name}.`);
    return found;
  });
}

export function resolveServer(config: ServerConfig, cwd: string): ServerConfig {
  const map = (values?: Record<string, string>) =>
    values &&
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, secretTemplate(value)]),
    );
  const result = {
    ...config,
    command: config.command && interpolate(config.command),
    args: config.args?.map((x) => interpolate(x)),
    env: map(config.env),
    headers: map(config.headers),
    url: config.url && interpolate(config.url),
  };
  if (config.command)
    result.cwd = resolve(
      cwd,
      interpolate(config.cwd ?? cwd).replace(/^~(?=\/|$)/, homedir()),
    );
  if (result.url) {
    const url = new URL(result.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("MCP URLs must use HTTP(S), without credentials or fragments.");
    result.url = url.href;
  }
  if (
    result.oauth &&
    Object.keys(result.headers ?? {}).some(
      (key) => key.toLowerCase() === "authorization",
    )
  )
    throw new Error("Use OAuth or an Authorization header, not both.");
  return result;
}

export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : object(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function matches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}
export function allowed(name: string, config: ServerConfig): boolean {
  return (
    !config.disabled &&
    (!config.includeTools || config.includeTools.some((p) => matches(name, p))) &&
    !config.excludeTools?.some((p) => matches(name, p))
  );
}
