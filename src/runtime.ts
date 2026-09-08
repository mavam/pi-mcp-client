import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  allowed,
  fingerprint,
  resolveServer,
  type Config,
  type ServerConfig,
} from "./config.js";
import { prepareTool, type CatalogTool } from "./catalog.js";
import { credentialStore, OAuthProvider } from "./auth.js";
import { resolveSecrets } from "./secrets.js";
import {
  diagnose,
  diagnostic,
  DiagnosticError,
  failure,
  formatDiagnostic,
  type Diagnostic,
} from "./diagnostics.js";

interface ServerState {
  client?: Client;
  transport?: Transport;
  connecting?: Promise<Client>;
  listing?: Promise<CatalogTool[]>;
  listingLive?: boolean;
  connectionIdentity?: string;
  connectionToken?: object;
  catalogGeneration: number;
  catalogDirty?: boolean;
  invalidating?: Promise<void>;
  tools?: CatalogTool[];
  identity?: string;
  error?: Diagnostic;
  warnings?: string[];
}
export interface ServerStatus {
  name: string;
  state: "disabled" | "connecting" | "failed" | "connected" | "disconnected";
  catalogSize?: number;
  error?: Diagnostic;
}
export class ToolContractError extends Error {}
export interface Discovery {
  tools: CatalogTool[];
  unavailable: string[];
  diagnostics: Diagnostic[];
  warnings: string[];
}
export type ConnectFactory = (
  name: string,
  config: ServerConfig,
  signal: AbortSignal,
  onToolsChanged?: () => void,
) => Promise<{ client: Client; transport: Transport }>;

export function waitFor<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    // Observe the shared promise even when this waiter was already cancelled.
    if (signal.aborted) abort();
  });
}

export const connectSdk: ConnectFactory = async (
  _name,
  config,
  signal,
  onToolsChanged,
) => {
  const timeout = config.timeoutMs ?? 15_000;
  const client = new Client(
    { name: "pi-mcp-client", version: "0.1.0" },
    {
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => onToolsChanged?.(),
        },
      },
      versionNegotiation: {
        mode: config.protocol ?? "auto",
        probe: { timeoutMs: timeout },
      },
    },
  );
  const transport = config.command
    ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stderr: "pipe",
      })
    : new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers: config.headers },
        authProvider: config.oauth
          ? new OAuthProvider(config.url!, await credentialStore(config.url!))
          : undefined,
        // Bound HTTP responses (including OAuth), but not established SSE streams.
        // The SDK bounds ordinary MCP requests with their request timeout.
        fetch: async (input, init) => {
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error("HTTP response timed out.")),
            timeout,
          );
          timer.unref();
          try {
            const response = await fetch(input, {
              ...init,
              signal: AbortSignal.any([
                signal,
                deadline.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
            if (response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream")
              clearTimeout(timer);
            return response;
          } catch (error) {
            clearTimeout(timer);
            throw error;
          }
        },
      });
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", () => {});
  try {
    await waitFor(
      client.connect(transport, { signal, timeout }),
      AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    );
    signal.throwIfAborted();
    return { client, transport };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
};

export class McpRuntime {
  private readonly states = new Map<string, ServerState>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(
    readonly config: Config,
    readonly cwd: string,
    private readonly cacheDir: string,
    private readonly connect: ConnectFactory = connectSdk,
  ) {}

  identity(name: string): string {
    const config = this.definition(name);
    let resolved: ServerConfig;
    try {
      resolved = resolveServer(config, this.cwd);
    } catch (error) {
      throw new DiagnosticError(
        diagnose(error, { server: name, operation: "configuration" }),
      );
    }
    return fingerprint({
      name,
      cwd: this.cwd,
      config: resolved,
      // Distinguish escaped literals from commands with the same rendered text.
      secretSources: { headers: config.headers, env: config.env },
      inheritedEnv: config.command ? getDefaultEnvironment() : undefined,
    });
  }
  private definition(name: string): ServerConfig {
    const config = Object.hasOwn(this.config, name)
      ? this.config[name]
      : undefined;
    if (!config || config.disabled)
      throw new ToolContractError(
        "MCP server is not configured or is disabled.",
      );
    return config;
  }
  private state(name: string): ServerState {
    let state = this.states.get(name);
    if (!state) {
      state = { catalogGeneration: 0 };
      this.states.set(name, state);
    }
    return state;
  }
  private async client(name: string): Promise<Client> {
    if (this.closing) throw new Error("MCP session ended.");
    this.lifetime.signal.throwIfAborted();
    const state = this.state(name);
    const identity = this.identity(name);
    if (
      (state.client || state.connecting) &&
      state.connectionIdentity !== identity
    )
      throw new ToolContractError(
        "MCP server configuration changed. Reload Pi before reconnecting.",
      );
    if (state.client) return state.client;
    if (state.connecting) return state.connecting;
    const config = resolveServer(this.definition(name), this.cwd);
    state.connectionIdentity = identity;
    const token = {};
    state.connectionToken = token;
    state.connecting = (async () => {
      const { client, transport } = await this.connect(
        name,
        await resolveSecrets(
          config,
          this.definition(name),
          this.cwd,
          this.lifetime.signal,
        ),
        this.lifetime.signal,
        () => {
          if (
            this.closing ||
            this.lifetime.signal.aborted ||
            state.connectionToken !== token
          )
            return;
          state.catalogGeneration++;
          state.catalogDirty = true;
          state.tools = undefined;
          state.warnings = undefined;
          const path = join(this.cacheDir, `${identity}.json`);
          state.invalidating = withFileMutationQueue(path, () =>
            rm(path, { force: true }),
          ).catch(() => {
            state.warnings = [
              `${name}: stale catalog cache could not be removed.`,
            ];
          });
        },
      );
      if (this.closing || this.lifetime.signal.aborted) {
        await client.autoOpenedSubscription?.close().catch(() => {});
        await client.close();
        throw new Error("MCP session ended.");
      }
      state.client = client;
      state.transport = transport;
      state.error = undefined;
      client.onclose = () => {
        if (state.client === client) {
          state.client = undefined;
          state.transport = undefined;
          state.connectionToken = undefined;
        }
      };
      return client;
    })()
      .catch((error) => {
        if (state.connectionToken === token) state.connectionToken = undefined;
        throw new DiagnosticError(
          diagnose(error, {
            server: name,
            operation: "connect",
            oauth: config.oauth,
            signal: this.lifetime.signal,
          }),
        );
      })
      .finally(() => {
        state.connecting = undefined;
      });
    return state.connecting;
  }

  async catalog(
    name: string,
    signal?: AbortSignal,
    refresh = false,
  ): Promise<CatalogTool[]> {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("MCP session ended.");
    this.lifetime.signal.throwIfAborted();
    const state = this.state(name);
    const identity = this.identity(name);
    refresh ||= !!state.catalogDirty;
    if (!refresh && state.tools && state.identity === identity)
      return state.tools;
    // A live validation must not accidentally join a disk-cache-only lookup.
    if (refresh && state.listing && !state.listingLive) {
      await waitFor(state.listing, signal);
      return this.catalog(name, signal, true);
    }
    if (!state.listing) {
      state.listingLive = refresh;
      state.listing = (async () => {
        // Retry only catalog reads, never invocations. Bound notification storms.
        for (let attempt = 0; attempt < 3; attempt++) {
          const generation = state.catalogGeneration;
          if (!refresh && !state.catalogDirty) {
            const cached = await this.readCache(name, identity);
            if (cached && generation === state.catalogGeneration) {
              state.tools = cached;
              state.identity = identity;
              return cached;
            }
          }
          const client = await this.client(name);
          const listed = await client.listTools(undefined, {
            signal: this.lifetime.signal,
            timeout: this.definition(name).timeoutMs ?? 15_000,
          });
          const tools: CatalogTool[] = [];
          const warnings: string[] = [];
          const seen = new Set<string>();
          for (const tool of listed.tools) {
            if (!allowed(tool.name, this.definition(name))) continue;
            try {
              const prepared = prepareTool(name, identity, tool);
              if (seen.has(prepared.nativeName))
                throw new Error("Duplicate tool name.");
              seen.add(prepared.nativeName);
              tools.push(prepared);
            } catch {
              warnings.push(
                `${name}: skipped an invalid, duplicate, or unsupported tool schema.`,
              );
            }
          }
          this.lifetime.signal.throwIfAborted();
          if (generation !== state.catalogGeneration) continue;
          await state.invalidating;
          await this.writeCache(
            identity,
            tools,
            () => generation === state.catalogGeneration,
          ).catch(() => {
            warnings.push(`${name}: catalog cache could not be saved.`);
          });
          if (generation !== state.catalogGeneration) continue;
          state.tools = tools;
          state.identity = identity;
          state.catalogDirty = false;
          state.error = undefined;
          state.warnings = warnings;
          return tools;
        }
        throw new ToolContractError(
          "MCP tool catalog kept changing. Retry discovery or activation.",
        );
      })()
        .catch((error) => {
          state.error = this.failure(name, error);
          throw new DiagnosticError(state.error);
        })
        .finally(() => {
          state.listing = undefined;
          state.listingLive = undefined;
        });
    }
    return waitFor(state.listing, signal);
  }

  async discover(server?: string | string[], signal?: AbortSignal): Promise<Discovery> {
    if (typeof server === "string") this.definition(server);
    const names = Array.isArray(server) ? [...new Set(server)] : server
      ? [server]
      : Object.keys(this.config)
          .filter((name) => !this.config[name].disabled)
          .sort();
    const result: Discovery = {
      tools: [],
      unavailable: [],
      diagnostics: [],
      warnings: [],
    };
    // At most four cold server discoveries in flight; each is independently bounded.
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, names.length) }, async () => {
        while (index < names.length) {
          signal?.throwIfAborted();
          const name = names[index++];
          try {
            result.tools.push(...(await this.catalog(name, signal)));
          } catch (error) {
            signal?.throwIfAborted();
            this.state(name).error = this.failure(name, error);
            result.diagnostics.push(this.state(name).error!);
            result.unavailable.push(formatDiagnostic(this.state(name).error!));
          }
          result.warnings.push(...(this.state(name).warnings ?? []));
        }
      }),
    );
    return result;
  }

  async call(
    tool: CatalogTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: (message: string) => void,
  ): Promise<CallToolResult> {
    const config = this.definition(tool.server);
    if (
      !allowed(tool.name, config) ||
      this.identity(tool.server) !== tool.identity
    )
      throw new ToolContractError(
        "MCP tool configuration changed. Search for the tool again.",
      );
    // Verify live schemas before invocation. Never execute against an old contract,
    // and never replay a call after an ambiguous transport failure.
    const current = await this.catalog(tool.server, signal, true);
    const found = current.find((candidate) => candidate.name === tool.name);
    if (!found || found.schemaHash !== tool.schemaHash)
      throw new ToolContractError(
        "MCP tool was removed or its schema changed. Use mcp_search with activate and its exact identifier to activate its current definition.",
      );
    const client = await waitFor(this.client(tool.server), signal);
    try {
      return await client.callTool(
        { name: tool.name, arguments: args },
        {
          signal: AbortSignal.any([
            this.lifetime.signal,
            ...(signal ? [signal] : []),
          ]),
          timeout: config.timeoutMs ?? 30_000,
          onprogress: (event) =>
            progress?.(
              event.message ??
                `${event.progress}${event.total === undefined ? "" : `/${event.total}`}`,
            ),
        },
      );
    } catch (error) {
      const value = diagnose(error, {
        server: tool.server,
        operation: "call",
        oauth: config.oauth,
        signal,
      });
      this.state(tool.server).error = value;
      throw new DiagnosticError(value);
    }
  }

  async reconnect(name: string): Promise<void> {
    this.definition(name);
    const state = this.state(name);
    if (state.connecting || state.listing)
      throw failure("busy", { server: name, operation: "reconnect" });
    await state.client?.autoOpenedSubscription?.close();
    await state.client?.close();
    state.client = undefined;
    await this.catalog(name, undefined, true);
  }
  serverStatuses(): ServerStatus[] {
    return Object.entries(this.config).map(([name, config]) => {
      const state = this.states.get(name);
      return {
        name,
        state: config.disabled ? "disabled"
          : state?.connecting || state?.listing ? "connecting"
          : state?.error ? "failed"
          : state?.client ? "connected" : "disconnected",
        catalogSize: state?.tools?.length,
        error: state?.error,
      };
    });
  }
  status(server?: string): string {
    return this.serverStatuses()
      .filter(({ name }) => server === undefined || name === server)
      .map((row) => {
        const status = row.state === "failed" && row.error
          ? formatDiagnostic({ ...row.error, server: undefined }) : row.state;
        return `${row.name}: ${status} · ${row.catalogSize ?? "unknown"} catalog tools`;
      }).join("\n") || "No MCP servers configured.";
  }
  close(): Promise<void> {
    return (this.closing ??= this.shutdown());
  }
  private async shutdown(): Promise<void> {
    // Send subscription cancellation while HTTP is still usable, then abort work.
    await Promise.all(
      [...this.states.values()].map((state) =>
        state.client?.autoOpenedSubscription?.close().catch(() => {}),
      ),
    );
    this.lifetime.abort(new Error("MCP session ended."));
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        await state.client?.close().catch(() => {});
        await state.connecting?.catch(() => {});
        await state.listing?.catch(() => {});
        await state.invalidating;
      }),
    );
  }
  private failure(name: string, error: unknown): Diagnostic {
    return error instanceof ToolContractError
      ? diagnostic("tool_changed", { server: name, operation: "search" })
      : diagnose(error, {
          server: name,
          operation: "search",
          oauth: this.config[name]?.oauth,
          signal: this.lifetime.signal,
        });
  }
  private async readCache(
    name: string,
    identity: string,
  ): Promise<CatalogTool[] | undefined> {
    try {
      const path = join(this.cacheDir, `${identity}.json`);
      const info = await stat(path);
      if (info.size > 4 * 1024 * 1024 || Date.now() - info.mtimeMs > 86_400_000)
        return;
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(data) || data.length > 10_000) return;
      return data
        .filter((tool) => allowed(tool.name, this.definition(name)))
        .map((tool) => prepareTool(name, identity, tool));
    } catch {
      return;
    }
  }
  private async writeCache(
    identity: string,
    tools: CatalogTool[],
    isCurrent: () => boolean,
  ): Promise<void> {
    const text = JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    );
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) return;
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = join(this.cacheDir, `${identity}.json`);
    await withFileMutationQueue(path, async () => {
      if (!isCurrent()) return;
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      // A notification can arrive during the write; never publish that snapshot.
      if (isCurrent()) await rename(temp, path);
      else await rm(temp, { force: true });
    });
  }
}
