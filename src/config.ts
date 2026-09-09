import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { secretTemplate } from "./secrets.js";

export interface ClientOptions {
  description?: string;
  oauth?: boolean;
  oauthClientId?: string;
  oauthScopes?: string[];
  oauthCallbackPort?: number;
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
  "oauthClientId",
  "oauthScopes",
  "oauthCallbackPort",
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
  if (entry.oauthClientId !== undefined &&
      (entry.oauth !== true || typeof entry.oauthClientId !== "string" ||
        !entry.oauthClientId.trim() || entry.oauthClientId.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(entry.oauthClientId)))
    fail("oauthClientId (requires oauth: true and a nonempty client ID)");
  if (entry.oauthScopes !== undefined &&
      (entry.oauth !== true || !Array.isArray(entry.oauthScopes) ||
        entry.oauthScopes.length === 0 || entry.oauthScopes.length > 100 ||
        !entry.oauthScopes.every((scope: unknown) => typeof scope === "string" &&
          scope.length <= 256 && /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)) ||
        new Set(entry.oauthScopes).size !== entry.oauthScopes.length))
    fail("oauthScopes (requires oauth: true and 1–100 unique OAuth scope tokens)");
  if (entry.oauthCallbackPort !== undefined &&
      (entry.oauth !== true || !Number.isInteger(entry.oauthCallbackPort) ||
        Number(entry.oauthCallbackPort) < 1 || Number(entry.oauthCallbackPort) > 65535))
    fail("oauthCallbackPort (requires oauth: true and a port from 1–65535)");
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

export type ConfigScope = "global" | "project";
export type ConfigMutation =
  | { action: "toggle"; server: string; disabled: boolean }
  | { action: "add"; server: string; scope: ConfigScope; definition: ServerConfig; replace: boolean }
  | { action: "remove"; server: string; scope: ConfigScope };

/** Messages from this class are safe to show without including raw configuration. */
export class ConfigMutationError extends Error {}

/** Canonicalize missing files too, without replacing dangling symlinks. */
async function configTarget(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink()) throw new ConfigMutationError("Configuration contains a dangling symlink; repair it before editing.");
    return join(await configTarget(dirname(path)), basename(path));
  }
}

/** Scoped, atomic updates; validation and read/modify/write share Pi's mutation queue. */
export async function updateServerConfig(
  agentDir: string,
  cwd: string,
  trusted: boolean,
  mutation: ConfigMutation,
  validate: (config: Config) => void,
): Promise<{ config: Config; scope: ConfigScope }> {
  if (mutation.action !== "toggle" && mutation.scope === "project" && !trusted)
    throw new ConfigMutationError("Project configuration requires a trusted project. Use global scope or trust the project first.");
  const paths = [join(agentDir, "mcp.json"), ...(trusted ? [join(cwd, ".mcp.json")] : [])];
  const targets = await Promise.all(paths.map(configTarget));
  if (mutation.action !== "toggle" && targets.length === 2 && targets[0] === targets[1])
    throw new ConfigMutationError("Global and project configuration share a file; separate them before scoped edits.");
  const locks = [...new Set(targets)].sort();
  const locked = async (index: number): Promise<{ config: Config; scope: ConfigScope }> => {
    if (index < locks.length)
      return withFileMutationQueue(locks[index], () => locked(index + 1));
    const documents = await Promise.all(targets.map(readJson));
    const parsed = documents.map((document, index) => document === undefined
      ? Object.create(null) as Config : parseConfig(document, paths[index]));
    const { server } = mutation;
    let source = mutation.action === "toggle" ? -1 : mutation.scope === "global" ? 0 : 1;
    if (mutation.action === "toggle") {
      for (const [index, config] of parsed.entries()) if (Object.hasOwn(config, server)) source = index;
      if (source < 0) throw new ConfigMutationError("Server is no longer configured. Run /mcp reload.");
    }
    const document = (documents[source] ?? { mcpServers: {} }) as { mcpServers: Record<string, ServerConfig> };
    let changed = true;
    if (mutation.action === "add") {
      // Validate even a new definition shadowed by another scope. Never resolve secrets by executing them.
      const definition = parseConfig({ mcpServers: { [server]: mutation.definition } })[server];
      resolveServer(definition, cwd);
      if (!mutation.replace && parsed.some((config) => Object.hasOwn(config, server)))
        throw new ConfigMutationError("Server already exists in global or trusted project configuration. Use --replace to replace or override it in the selected scope.");
      document.mcpServers[server] = structuredClone(mutation.definition);
    } else if (mutation.action === "remove") {
      if (!Object.hasOwn(document.mcpServers, server))
        throw new ConfigMutationError("Server is not defined in the selected scope. No configuration was changed.");
      delete document.mcpServers[server];
    } else {
      changed = Boolean(document.mcpServers[server].disabled) !== mutation.disabled;
      if (changed) document.mcpServers[server].disabled = mutation.disabled;
    }
    // Aliases are allowed for effective-source toggles; reflect the same physical edit in both layers.
    for (const [index, target] of targets.entries())
      if (target === targets[source]) documents[index] = document;
    const config: Config = Object.assign(Object.create(null), ...documents.map((document, index) =>
      document === undefined ? {} : parseConfig(document, paths[index]),
    ));
    validate(config);
    if (changed) {
      const target = targets[source];
      const mode = await stat(target).then((info) => info.mode & 0o777).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return 0o600;
      });
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { mode: 0o600, flag: "wx" });
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

/** Toggle the effective definition, preserving unresolved secrets and other fields. */
export function setServerDisabled(
  agentDir: string,
  cwd: string,
  trusted: boolean,
  server: string,
  disabled: boolean,
  validate: (config: Config) => void,
): Promise<{ config: Config; scope: ConfigScope }> {
  return updateServerConfig(agentDir, cwd, trusted, { action: "toggle", server, disabled }, validate);
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
    oauthClientId: config.oauthClientId === undefined ? undefined : interpolate(config.oauthClientId),
  };
  if (result.oauthClientId !== undefined &&
      (!result.oauthClientId.trim() || result.oauthClientId.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(result.oauthClientId)))
    throw new Error("OAuth client ID must be nonempty and contain no control characters.");
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
