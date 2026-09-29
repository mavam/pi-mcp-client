import { chmod, lstat, mkdir, readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { secretTemplate } from "./secrets.js";

export type Exposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";
const EXPOSURES: readonly string[] = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];

export interface ClientOptions {
  description?: string;
  oauthClientId?: string;
  oauthScopes?: string[];
  oauthCallbackPort?: number;
  oauthDpop?: boolean;
  disabled?: boolean;
  /** Only `hidden` changes behavior here: tools are always discovered, then activated. */
  exposure?: Exposure;
  toolExposure?: Record<string, Exposure>;
  timeoutMs?: number;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  protocol?: "legacy" | "auto";
}

/**
 * Normalized runtime configuration, derived from a server entry in `mcp.json`. The file shape
 * follows Pi's built-in MCP support (`enabled`, `exposure`, `toolExposure`, `timeout`, `oauth`),
 * so one file works with either extension; explicit transport tags are validated, then inferred.
 */
export interface ServerConfig extends ClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export type Config = Record<string, ServerConfig>;
/** A server entry as written to `mcp.json`. */
export type FileServer = Record<string, unknown>;

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const FIELDS = new Set([
  "type", "command", "args", "cwd", "env", "url", "headers",
  "description", "enabled", "exposure", "toolExposure", "timeout",
  "startupTimeout", "toolTimeout", "oauth", "protocol",
]);
const OAUTH_FIELDS = new Set(["clientId", "scope", "callbackPort", "dpop"]);

/** Seconds in the file, milliseconds at runtime. */
function seconds(value: unknown, field: string, fail: (field: string) => never): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "number" ? Math.round(value * 1000) : NaN;
  if (!Number.isInteger(ms) || ms < 100 || ms > 600_000) fail(`${field} (0.1–600 seconds)`);
  return ms;
}

function parseServer(
  entry: Record<string, unknown>,
  fail: (field: string) => never,
): ServerConfig {
  for (const key of Object.keys(entry)) if (!FIELDS.has(key)) fail(key);
  if (
    entry.description !== undefined &&
    (typeof entry.description !== "string" || !entry.description)
  )
    fail("description");
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") fail("enabled");
  if (entry.exposure !== undefined && !EXPOSURES.includes(entry.exposure as string)) fail("exposure");
  if (entry.toolExposure !== undefined &&
      (!object(entry.toolExposure) || !Object.values(entry.toolExposure).every((mode) => EXPOSURES.includes(mode as string))))
    fail("toolExposure");
  if (
    entry.protocol !== undefined &&
    entry.protocol !== "legacy" &&
    entry.protocol !== "auto"
  )
    fail("protocol");
  if (entry.type !== undefined && entry.type !== "stdio" && entry.type !== "http" && entry.type !== "streamable-http")
    fail("type (supported transports: stdio, http; SSE is not supported)");
  for (const key of ["command", "cwd", "url"]) {
    if (entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key]))
      fail(key);
  }
  if (entry.args !== undefined &&
      (!Array.isArray(entry.args) || !entry.args.every((x: unknown) => typeof x === "string")))
    fail("args");
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
    ((entry.type === "http" || entry.type === "streamable-http") && !entry.url)
  )
    fail("type (must match command or url)");
  if (entry.command && (entry.headers || entry.oauth !== undefined))
    fail("HTTP options on stdio transport");
  if (entry.url && (entry.args || entry.cwd || entry.env))
    fail("stdio options on HTTP transport");
  const config: ServerConfig = {};
  for (const key of ["command", "args", "cwd", "env", "url", "headers", "description", "protocol", "exposure", "toolExposure"] as const)
    if (entry[key] !== undefined) (config as Record<string, unknown>)[key] = structuredClone(entry[key]);
  if (entry.enabled === false) config.disabled = true;
  const timeoutMs = seconds(entry.timeout, "timeout", fail);
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  const startupTimeoutMs = seconds(entry.startupTimeout, "startupTimeout", fail);
  if (startupTimeoutMs !== undefined) config.startupTimeoutMs = startupTimeoutMs;
  const toolTimeoutMs = seconds(entry.toolTimeout, "toolTimeout", fail);
  if (toolTimeoutMs !== undefined) config.toolTimeoutMs = toolTimeoutMs;
  if (entry.oauth !== undefined) {
    const oauth = entry.oauth;
    if (!object(oauth)) return fail("oauth");
    if (oauth.clientSecret !== undefined || oauth.callbackUrl !== undefined)
      fail("oauth (clientSecret and callbackUrl are not supported; this extension supports public clients on loopback port callbacks)");
    for (const key of Object.keys(oauth)) if (!OAUTH_FIELDS.has(key)) fail(`oauth.${key}`);
    if (oauth.clientId !== undefined &&
        (typeof oauth.clientId !== "string" ||
          !oauth.clientId.trim() || oauth.clientId.length > 4096 ||
          /[\u0000-\u001f\u007f]/u.test(oauth.clientId)))
      fail("oauth.clientId (requires a nonempty client ID)");
    if (oauth.scope !== undefined) {
      const scopes = typeof oauth.scope === "string" ? oauth.scope.split(" ").filter(Boolean) : [];
      if (scopes.length === 0 || scopes.length > 100 ||
          !scopes.every((scope) => scope.length <= 256 && /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)) ||
          new Set(scopes).size !== scopes.length)
        fail("oauth.scope (requires 1–100 unique space-separated OAuth scope tokens)");
      config.oauthScopes = scopes;
    }
    if (oauth.callbackPort !== undefined &&
        (!Number.isInteger(oauth.callbackPort) ||
          Number(oauth.callbackPort) < 1 || Number(oauth.callbackPort) > 65535))
      fail("oauth.callbackPort (a port from 1–65535)");
    if (oauth.dpop !== undefined && typeof oauth.dpop !== "boolean") fail("oauth.dpop (requires a boolean)");
    if (oauth.clientId !== undefined) config.oauthClientId = oauth.clientId as string;
    if (oauth.callbackPort !== undefined) config.oauthCallbackPort = oauth.callbackPort as number;
    if (oauth.dpop !== undefined) config.oauthDpop = oauth.dpop as boolean;
  }
  return config;
}

function parseConnections(value: unknown, source: string): Config {
  if (!object(value) || !object(value.mcpServers)) {
    throw new Error(`${source}: expected an mcpServers object.`);
  }
  if (Object.hasOwn(value, "pi"))
    throw new Error(`${source}: the pi section is not supported. Put server options directly in mcpServers.<server>.`);
  const result: Config = Object.create(null);
  for (const [name, entry] of Object.entries(value.mcpServers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name) || !object(entry)) {
      throw new Error(`${source}: invalid server name or definition.`);
    }
    result[name] = parseServer(entry, (field): never => {
      throw new Error(`${source}: invalid ${field} for server ${name}.`);
    });
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
    ...(trusted ? [join(cwd, ".pi", "mcp.json")] : []),
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
  | { action: "add"; server: string; scope: ConfigScope; definition: FileServer; replace: boolean }
  | { action: "remove"; server: string; scope: ConfigScope }
  | { action: "import"; scope: ConfigScope; servers: Record<string, FileServer>; expected: string; sourcePath: string };

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

/** Read both authorized scopes for an import preview; never resolve connection values. */
export async function inspectConfigScopes(agentDir: string, cwd: string, trusted: boolean) {
  const paths = [join(agentDir, "mcp.json"), ...(trusted ? [join(cwd, ".pi", "mcp.json")] : [])];
  const targets = await Promise.all(paths.map(configTarget));
  if (targets.length === 2 && targets[0] === targets[1])
    throw new ConfigMutationError("Global and project configuration share a file; separate them before scoped edits.");
  const documents = await Promise.all(targets.map(readJson));
  const parsed = documents.map((document, index) => document === undefined
    ? Object.create(null) as Config : parseConfig(document, paths[index]));
  return {
    global: parsed[0],
    project: parsed[1] ?? Object.create(null) as Config,
    targets: { global: targets[0], project: targets[1] },
    expected: fingerprint({ targets, documents: documents.map((document) => document ?? null) }),
  };
}

/** Scoped, atomic updates; validation and read/modify/write share Pi's mutation queue. */
export async function updateServerConfig(
  agentDir: string,
  cwd: string,
  trusted: boolean,
  mutation: ConfigMutation,
  validate: (config: Config) => void,
): Promise<{ config: Config; scope: ConfigScope }> {
  const scoped = mutation.action !== "toggle";
  if (scoped && mutation.scope === "project" && !trusted)
    throw new ConfigMutationError("Project configuration requires a trusted project. Use global scope, or run /trust to trust this folder first.");
  const paths = [join(agentDir, "mcp.json"), ...(trusted ? [join(cwd, ".pi", "mcp.json")] : [])];
  const targets = await Promise.all(paths.map(configTarget));
  if (scoped && targets.length === 2 && targets[0] === targets[1])
    throw new ConfigMutationError("Global and project configuration share a file; separate them before scoped edits.");
  const locks = [...new Set(targets)].sort();
  const locked = async (index: number): Promise<{ config: Config; scope: ConfigScope }> => {
    if (index < locks.length)
      return withFileMutationQueue(locks[index], () => locked(index + 1));
    const documents = await Promise.all(targets.map(readJson));
    const parsed = documents.map((document, index) => document === undefined
      ? Object.create(null) as Config : parseConfig(document, paths[index]));
    if (mutation.action === "import" && mutation.expected !== fingerprint({
      targets, documents: documents.map((document) => document ?? null),
    })) throw new ConfigMutationError("MCP configuration changed since the preview. Run /mcp import again; nothing was saved.");
    const server = mutation.action === "import" ? "" : mutation.server;
    let source = scoped ? mutation.scope === "global" ? 0 : 1 : -1;
    if (!scoped) {
      for (const [index, config] of parsed.entries()) if (Object.hasOwn(config, server)) source = index;
      if (source < 0) throw new ConfigMutationError("Server is no longer configured. Run /mcp reload.");
    }
    const document = (documents[source] ?? { mcpServers: {} }) as { mcpServers: Record<string, FileServer> };
    let changed = true;
    if (mutation.action === "import") {
      if (targets[source] === mutation.sourcePath)
        throw new ConfigMutationError("Import source and destination are the same file. Choose a different destination scope or source file.");
      const imported = parseConfig({ mcpServers: mutation.servers });
      if (!Object.keys(imported).length) throw new ConfigMutationError("No servers selected for import.");
      for (const [name, definition] of Object.entries(imported)) {
        // Check every imported definition, including disabled and shadowed entries.
        resolveServer(definition, cwd);
        document.mcpServers[name] = structuredClone(mutation.servers[name]);
      }
    } else if (mutation.action === "add") {
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
      const entry = document.mcpServers[server] as FileServer;
      changed = (entry.enabled === false) !== mutation.disabled;
      if (changed) {
        if (mutation.disabled) entry.enabled = false;
        else delete entry.enabled;
      }
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
    (result.oauthClientId !== undefined || result.oauthScopes !== undefined || result.oauthCallbackPort !== undefined || result.oauthDpop !== undefined) &&
    Object.keys(result.headers ?? {}).some(
      (key) => key.toLowerCase() === "authorization",
    )
  )
    throw new Error("Use OAuth or an Authorization header, not both.");
  return result;
}

/** HTTP authentication is automatic unless an Authorization header is configured. */
export function usesOAuth(config: ServerConfig | undefined): boolean {
  return Boolean(config?.url) &&
    !Object.keys(config?.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
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

function matches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u").test(name);
}

/** Exposure of one tool: an exact `toolExposure` key, else the first matching pattern, else the server's. */
export function toolExposure(name: string, config: ServerConfig): Exposure {
  const overrides = config.toolExposure ?? {};
  if (Object.hasOwn(overrides, name)) return overrides[name];
  for (const [pattern, mode] of Object.entries(overrides))
    if (pattern.includes("*") && matches(name, pattern)) return mode;
  return config.exposure ?? "codemode";
}

export function allowed(name: string, config: ServerConfig): boolean {
  return !config.disabled && toolExposure(name, config) !== "hidden";
}
