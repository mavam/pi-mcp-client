import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  extractWWWAuthenticateParams,
  computeScopeUnion,
  type CallToolResult,
  type ElicitRequestParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type ReadResourceResult,
  UriTemplate,
  type Transport,
} from "@modelcontextprotocol/client";
import packageJson from "../package.json" with { type: "json" };
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  allowed,
  usesOAuth,
  fingerprint,
  resolveServer,
  type Config,
  type ServerConfig,
} from "./config.js";
import { prepareTool, type CatalogTool } from "./catalog.js";
import { prepareResource, prepareResourceTemplate, validTemplateRead, validResourceUri, validCompletion, type CompletionTarget, type TemplateTarget, type CatalogResource, type DiscoveryKind } from "./resources.js";
import { connectionAuthProvider, credentialStore, type CredentialStoreFactory } from "./auth.js";
import { privateOAuthFetch } from "./oauth-fetch.js";
import { parseScopes, type ScopeChallenge } from "./authorization.js";
import { preparePrompt, validPromptArguments, type CatalogPrompt } from "./prompts.js";
import { ResourceSubscriptions } from "./subscriptions.js";
import { resolveSecrets } from "./secrets.js";
import { awaitCompletion, elicit, requiredElicitations, type ElicitationUI } from "./elicitation.js";
import {
  diagnose,
  diagnostic,
  DiagnosticError,
  failure,
  formatDiagnostic,
  type Diagnostic,
} from "./diagnostics.js";

interface ResourceMetadataCache {
  resources?: CatalogResource[];
  resourceIdentity?: string;
  resourceListedAt?: number;
  resourceListing?: Promise<CatalogResource[]>;
  resourceWarnings?: string[];
  generation?: number;
}
/** A tool call that can present server requests to the user. */
interface CallScope {
  ui: ElicitationUI;
  deadline: Deadline;
  progress?: (message: string) => void;
}
interface ServerState extends ResourceMetadataCache {
  scopes?: Set<CallScope>;
  scopesEnded?: AbortController;
  pendingElicitations?: number;
  awaitingCompletion?: Map<string, Set<() => void>>;
  client?: Client;
  transport?: Transport;
  connecting?: Promise<Client>;
  listing?: Promise<CatalogTool[]>;
  listingLive?: boolean;
  connectionIdentity?: string;
  connectionToken?: object;
  catalogGeneration: number;
  resourceGeneration: number;
  promptGeneration: number;
  prompts?: CatalogPrompt[];
  promptListedAt?: number;
  promptIdentity?: string;
  promptListing?: Promise<CatalogPrompt[]>;
  templateCache?: ResourceMetadataCache;
  subscriptions?: ResourceSubscriptions;
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
  resources: CatalogResource[];
  templates?: CatalogResource[];
  prompts?: CatalogPrompt[];
  unavailable: string[];
  diagnostics: Diagnostic[];
  warnings: string[];
}
export interface ConnectionHandlers {
  scopeChallenge?: (scope: string | undefined) => void;
  toolsChanged?: () => void;
  resourcesChanged?: () => void;
  promptsChanged?: () => void;
  /** Supplied only in interactive sessions; its presence declares elicitation support. */
  elicit?: (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>;
  elicitationComplete?: (elicitationId: string) => void;
}
export type ConnectFactory = (
  name: string,
  config: ServerConfig,
  signal: AbortSignal,
  handlers?: ConnectionHandlers,
) => Promise<{ client: Client; transport: Transport }>;

/** Largest timer delay; the pausable call deadline bounds tool calls instead. */
const UNBOUNDED_TIMEOUT = 2_147_483_647;
const MAX_PENDING_ELICITATIONS = 4;

/** A call deadline that stops while the user answers a server request. */
class Deadline {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer?: ReturnType<typeof setTimeout>;
  private started = 0;
  private holds = 0;
  private done = false;
  constructor(private remaining: number) {
    this.start();
  }
  private start() {
    this.started = Date.now();
    this.timer = setTimeout(
      () => this.controller.abort(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out")),
      Math.max(0, this.remaining),
    );
  }
  pause() {
    if (this.holds++ || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining -= Date.now() - this.started;
  }
  resume() {
    if (--this.holds || this.done || this.signal.aborted) return;
    this.start();
  }
  dispose() {
    this.done = true;
    clearTimeout(this.timer);
  }
}

/** One SDK client per connection. Protocol behavior stays in the SDK. */
export function createClient(config: ServerConfig, handlers: ConnectionHandlers = {}): Client {
  const { elicit, elicitationComplete } = handlers;
  const client = new Client(
    { name: "pi-mcp-client", version: packageJson.version },
    {
      ...(elicit ? { capabilities: { elicitation: { form: {}, url: {} } } } : {}),
      listChanged: {
        tools: { autoRefresh: false, debounceMs: 0, onChanged: () => handlers.toolsChanged?.() },
        prompts: { autoRefresh: false, debounceMs: 0, onChanged: () => handlers.promptsChanged?.() },
        resources: { autoRefresh: false, debounceMs: 0, onChanged: () => handlers.resourcesChanged?.() },
      },
      versionNegotiation: {
        mode: config.protocol ?? "auto",
        probe: { timeoutMs: config.startupTimeoutMs ?? config.timeoutMs ?? 15_000 },
      },
    },
  );
  if (elicit) {
    // Legacy requests and 2026-07-28 input_required rounds share this handler.
    client.setRequestHandler("elicitation/create", (request, ctx) => elicit(request.params, ctx.mcpReq.signal));
    client.setNotificationHandler("notifications/elicitation/complete", (notification) =>
      elicitationComplete?.(notification.params.elicitationId));
  }
  return client;
}

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

export const createSdkConnector = (storeFactory: CredentialStoreFactory = credentialStore): ConnectFactory => async (
  name,
  config,
  signal,
  handlers,
) => {
  const timeout = config.timeoutMs ?? 15_000;
  const startupTimeout = config.startupTimeoutMs ?? timeout;
  let connecting = true;
  const client = createClient(config, handlers);
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
        authProvider: await connectionAuthProvider(name, config, storeFactory),
        // Approval and resubmission belong to the user, not transport retries.
        onInsufficientScope: "throw",
        // Bound HTTP responses (including OAuth), but not established SSE streams.
        // Accommodate startup/tool overrides; the SDK enforces each request's tighter deadline.
        fetch: async (input, init) => {
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error("HTTP response timed out.")),
            connecting ? startupTimeout : Math.max(timeout, config.toolTimeoutMs ?? timeout),
          );
          timer.unref();
          try {
            const response = await privateOAuthFetch(input, {
              ...init,
              signal: AbortSignal.any([
                signal,
                deadline.signal,
                ...(init?.signal ? [init.signal] : []),
              ]),
            });
            if (response.status === 403 && usesOAuth(config)) {
              const challenge = extractWWWAuthenticateParams(response);
              if (challenge.error === "insufficient_scope") handlers?.scopeChallenge?.(challenge.scope);
            }
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
      client.connect(transport, { signal, timeout: startupTimeout }),
      AbortSignal.any([signal, AbortSignal.timeout(startupTimeout)]),
    );
    signal.throwIfAborted();
    connecting = false;
    return { client, transport };
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
};

export const connectSdk = createSdkConnector();

export class McpRuntime {
  private readonly states = new Map<string, ServerState>();
  private readonly scopeChallenges = new Map<string, ScopeChallenge>();
  private readonly lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(
    readonly config: Config,
    readonly cwd: string,
    private readonly cacheDir: string,
    private readonly connect: ConnectFactory = connectSdk,
    /** Interactive sessions declare elicitation support to servers. */
    private readonly options: { interactive?: boolean } = {},
  ) {}

  /** Challenges are session-local, expire, and never survive configuration changes. */
  authorizationChallenge(name: string): ScopeChallenge | undefined {
    const challenge = this.scopeChallenges.get(name);
    if (!challenge || challenge.expires < Date.now() || challenge.identity !== this.identity(name)) {
      this.scopeChallenges.delete(name);
      return undefined;
    }
    return challenge;
  }
  clearAuthorizationChallenge(name: string, approved: ScopeChallenge) {
    if (this.scopeChallenges.get(name) === approved) this.scopeChallenges.delete(name);
  }

  onResourceUpdated?: (server: string, uri: string) => void;
  private subscriptionGeneration = 0;
  private subscriptionCleanup: Promise<void> = Promise.resolve();

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
      state = { catalogGeneration: 0, resourceGeneration: 0, promptGeneration: 0 };
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
        {
          scopeChallenge: (scope) => {
            if (this.closing || this.lifetime.signal.aborted || state.connectionToken !== token) return;
            const scopes = parseScopes(scope);
            const previous = this.authorizationChallenge(name);
            const union = scopes && parseScopes(computeScopeUnion(previous?.scopes.join(" "), scopes.join(" ")));
            if (union) this.scopeChallenges.set(name, { scopes: union, identity, expires: Date.now() + 600_000 });
            else this.scopeChallenges.delete(name);
          },
          toolsChanged: () => {
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
          resourcesChanged: () => {
            if (this.closing || this.lifetime.signal.aborted || state.connectionToken !== token) return;
            state.resourceGeneration++;
            state.resources = undefined;
            state.resourceWarnings = undefined;
          },
          promptsChanged: () => {
            if (this.closing || this.lifetime.signal.aborted || state.connectionToken !== token) return;
            state.promptGeneration++;
            state.prompts = undefined;
          },
          ...(this.options.interactive ? {
            elicit: (params: ElicitRequestParams, signal: AbortSignal) => this.elicit(name, state, token, params, signal),
            elicitationComplete: (id: string) => {
              if (state.connectionToken === token)
                for (const complete of state.awaitingCompletion?.get(id) ?? []) complete();
            },
          } : {}),
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
          const subscriptions = state.subscriptions;
          state.subscriptions = undefined;
          void subscriptions?.close(false);
          state.resourceGeneration++;
          state.resources = undefined;
          state.promptGeneration++;
          state.prompts = undefined;
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
            oauth: usesOAuth(config),
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
          const listed = client.getServerCapabilities && !client.getServerCapabilities()?.tools
            ? { tools: [] }
            : await client.listTools(undefined, {
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

  /** Resource catalog caches are memory-only; bodies are never cataloged or cached. */
  async resourceCatalog(name: string, signal?: AbortSignal, refresh = false, templates = false): Promise<CatalogResource[]> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.closing) throw new Error("MCP session ended.");
    const identity = this.identity(name);
    const owner = this.state(name);
    const state = templates ? owner.templateCache ??= {} : owner;
    if (refresh) state.resources = undefined;
    if (!refresh && state.resources && state.generation === owner.resourceGeneration && state.resourceIdentity === identity &&
        Date.now() - (state.resourceListedAt ?? 0) < 300_000) return state.resources;
    if (!state.resourceListing) state.resourceListing = (async () => {
      const deadline = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.definition(name).timeoutMs ?? 15_000)]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = owner.resourceGeneration;
        const client = await waitFor(this.client(name), deadline);
        const options = { signal: deadline, timeout: this.definition(name).timeoutMs ?? 15_000, cacheMode: "bypass" as const };
        const listed = !client.getServerCapabilities?.()?.resources ? [] : templates
          ? (await client.listResourceTemplates(undefined, options)).resourceTemplates
          : (await client.listResources(undefined, options)).resources;
        if (listed.length > 10_000 || Buffer.byteLength(JSON.stringify(listed)) > 4 * 1024 * 1024)
          throw failure("protocol_error", { server: name, operation: "search" });
        const resources: CatalogResource[] = [];
        const warnings: string[] = [];
        const seen = new Set<string>();
        for (const resource of listed) {
          try {
            const prepared = (templates ? prepareResourceTemplate : prepareResource)(name, identity, resource);
            if (seen.has(prepared.uri)) throw new Error("Duplicate resource URI.");
            seen.add(prepared.uri);
            resources.push(prepared);
          } catch { warnings.push(`${name}: skipped an invalid or duplicate resource descriptor.`); }
        }
        deadline.throwIfAborted();
        if (generation !== owner.resourceGeneration) continue;
        state.generation = generation;
        state.resources = resources;
        state.resourceIdentity = identity;
        state.resourceListedAt = Date.now();
        state.resourceWarnings = [...new Set(warnings)];
        return resources;
      }
      throw failure("catalog_changed", { server: name, operation: "search" });
    })().finally(() => { state.resourceListing = undefined; });
    return waitFor(state.resourceListing, signal);
  }

  /** Metadata only, memory-only; SDK pagination and notifications own protocol behavior. */
  async promptCatalog(name: string, signal?: AbortSignal, refresh = false): Promise<CatalogPrompt[]> {
    signal?.throwIfAborted();
    this.lifetime.signal.throwIfAborted();
    if (this.closing) throw new Error("MCP session ended.");
    const identity = this.identity(name);
    const state = this.state(name);
    if (refresh) { state.promptGeneration++; state.prompts = undefined; }
    if (state.prompts && state.promptIdentity === identity && Date.now() - (state.promptListedAt ?? 0) < 300_000) return state.prompts;
    if (!state.promptListing) state.promptListing = (async () => {
      const deadline = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.definition(name).timeoutMs ?? 15_000)]);
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = state.promptGeneration;
        const client = await waitFor(this.client(name), deadline);
        const listed = !client.getServerCapabilities()?.prompts ? [] :
          (await client.listPrompts(undefined, { signal: deadline, timeout: this.definition(name).timeoutMs ?? 15_000, cacheMode: "bypass" })).prompts;
        if (listed.length > 10_000 || Buffer.byteLength(JSON.stringify(listed)) > 4 * 1024 * 1024)
          throw failure("protocol_error", { server: name, operation: "search" });
        const prompts = listed.map((value) => preparePrompt(name, identity, value));
        if (new Set(prompts.map((prompt) => prompt.name)).size !== prompts.length)
          throw failure("protocol_error", { server: name, operation: "search" });
        deadline.throwIfAborted();
        if (generation !== state.promptGeneration) continue;
        state.prompts = prompts;
        state.promptIdentity = identity;
        state.promptListedAt = Date.now();
        return prompts;
      }
      throw failure("catalog_changed", { server: name, operation: "search" });
    })().finally(() => { state.promptListing = undefined; });
    return waitFor(state.promptListing, signal);
  }

  /** Explicit command only. No model-facing get operation, cached bodies, or retries. */
  async getPrompt(name: string, promptName: string, args: Record<string, string>, signal?: AbortSignal) {
    const config = this.definition(name);
    const combined = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(config.timeoutMs ?? 15_000), ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      const client = await waitFor(this.client(name), combined);
      if (!client.getServerCapabilities()?.prompts) throw failure("prompts_unsupported", { server: name, operation: "prompt" });
      const prompt = (await this.promptCatalog(name, combined)).find((item) => item.name === promptName);
      if (!prompt) throw failure("prompt_not_found", { server: name, operation: "prompt" });
      if (!validPromptArguments(prompt, args)) throw failure("prompt_invalid", { server: name, operation: "prompt" });
      const result = await client.getPrompt({ name: promptName, arguments: args }, { signal: combined, timeout: config.timeoutMs ?? 15_000 });
      combined.throwIfAborted();
      this.state(name).error = undefined;
      return result;
    } catch (error) {
      const value = diagnose(error, { server: name, operation: "prompt", oauth: usesOAuth(config), signal: combined });
      this.state(name).error = value;
      throw new DiagnosticError(value);
    }
  }

  async expandResourceTemplate(target: TemplateTarget, signal?: AbortSignal): Promise<string> {
    if (!validTemplateRead(target as unknown as Record<string, unknown>))
      throw failure("resource_invalid", { server: target.server, operation: "read" });
    const templates = await this.resourceCatalog(target.server, signal, false, true);
    if (!templates.some((entry) => entry.uri === target.template))
      throw failure("resource_not_found", { server: target.server, operation: "read" });
    const uri = new UriTemplate(target.template).expand(target.arguments);
    if (!validResourceUri(uri)) throw failure("resource_invalid", { server: target.server, operation: "read" });
    return uri;
  }

  async completeResource(target: CompletionTarget, signal?: AbortSignal) {
    if (!validCompletion(target)) throw failure("completion_invalid", { operation: "complete" });
    const config = Object.hasOwn(this.config, target.server) ? this.config[target.server] : undefined;
    if (!config || config.disabled)
      throw failure(config ? "server_disabled" : "server_unknown", { server: target.server, operation: "complete" });
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    const templates = await this.resourceCatalog(target.server, combined, false, true);
    const template = templates.find((entry) => entry.uri === target.template);
    if (!template) throw failure("resource_not_found", { server: target.server, operation: "complete" });
    if (!template.variables?.includes(target.argument.name))
      throw failure("completion_invalid", { server: target.server, operation: "complete" });
    const client = await waitFor(this.client(target.server), combined);
    if (!client.getServerCapabilities()?.completions)
      throw failure("completions_unsupported", { server: target.server, operation: "complete" });
    const result = await client.complete({
      ref: { type: "ref/resource", uri: target.template }, argument: target.argument,
      ...(target.arguments === undefined ? {} : { context: { arguments: target.arguments } }),
    }, { signal: combined, timeout: config.timeoutMs ?? 15_000 });
    combined.throwIfAborted();
    // Never retain arbitrary extension fields returned by a server.
    return { values: result.completion.values, total: result.completion.total, hasMore: result.completion.hasMore };
  }

  resourceSubscriptions() {
    return [...this.states].flatMap(([server, state]) =>
      (state.subscriptions?.list() ?? []).map((watch) => ({ server, ...watch })));
  }

  async setResourceSubscription(name: string, uri: string, subscribe: boolean, signal?: AbortSignal) {
    if (!validResourceUri(uri)) throw failure("resource_invalid", { server: name, operation: "subscribe" });
    const definition = Object.hasOwn(this.config, name) ? this.config[name] : undefined;
    if (!definition || definition.disabled)
      throw failure(definition ? "server_disabled" : "server_unknown", { server: name, operation: "subscribe" });
    const generation = this.subscriptionGeneration;
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    combined.throwIfAborted();
    if (!subscribe) {
      await this.states.get(name)?.subscriptions?.set(uri, false, combined);
      return;
    }
    await waitFor(this.subscriptionCleanup, combined);
    combined.throwIfAborted();
    if (generation !== this.subscriptionGeneration || this.closing)
      throw failure("cancelled", { server: name, operation: "subscribe" });
    const client = await waitFor(this.client(name), combined);
    combined.throwIfAborted();
    if (generation !== this.subscriptionGeneration || this.closing)
      throw failure("cancelled", { server: name, operation: "subscribe" });
    const state = this.state(name);
    const subscriptions = state.subscriptions ??= new ResourceSubscriptions(client, name, definition.timeoutMs ?? 15_000,
      (updated) => {
        if (!this.closing && state.client === client && state.subscriptions === subscriptions)
          this.onResourceUpdated?.(name, updated);
      });
    await subscriptions.set(uri, true, combined);
  }

  clearResourceSubscriptions(): Promise<void> {
    this.subscriptionGeneration++;
    const closing = [...this.states.values()].map(async (state) => {
      const subscriptions = state.subscriptions;
      state.subscriptions = undefined;
      await subscriptions?.close();
    });
    // A new branch must not subscribe until the old branch's legacy
    // unsubscriptions have finished cancelling the same URIs.
    this.subscriptionCleanup = Promise.all([this.subscriptionCleanup, ...closing]).then(() => {});
    return this.subscriptionCleanup;
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    signal?.throwIfAborted();
    const config = Object.hasOwn(this.config, name) ? this.config[name] : undefined;
    if (!config || config.disabled) throw failure(config ? "server_disabled" : "server_unknown", { server: name, operation: "read" });
    if (!validResourceUri(uri)) throw failure("resource_invalid", { server: name, operation: "read" });
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    try {
      const client = await waitFor(this.client(name), combined);
      if (!client.getServerCapabilities()?.resources)
        throw failure("resources_unsupported", { server: name, operation: "read" });
      // Exact URI, including unlisted tool-returned links. No local/HTTP fallback,
      // recursive reads, content cache, or automatic retry.
      const result = await client.readResource({ uri }, {
        signal: combined, timeout: config.timeoutMs ?? 15_000, cacheMode: "bypass",
      });
      combined.throwIfAborted();
      this.state(name).error = undefined;
      return result;
    } catch (error) {
      const value = diagnose(error, { server: name, operation: "read", oauth: usesOAuth(config), signal: combined });
      this.state(name).error = value;
      throw new DiagnosticError(value);
    }
  }

  async discover(server?: string | string[], signal?: AbortSignal, kind: DiscoveryKind = "tools"): Promise<Discovery> {
    if (typeof server === "string") {
      const config = Object.hasOwn(this.config, server) ? this.config[server] : undefined;
      if (!config || config.disabled)
        throw new DiagnosticError(diagnostic(
          config ? "server_disabled" : "server_unknown",
          { server, operation: "search" },
        ));
    }
    const names = Array.isArray(server) ? [...new Set(server)] : server
      ? [server]
      : Object.keys(this.config)
          .filter((name) => !this.config[name].disabled)
          .sort();
    const result: Discovery = {
      tools: [],
      resources: [],
      templates: [],
      prompts: [],
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
          let connectionFailed = false;
          const record = (error: unknown, catalog: string) => {
            signal?.throwIfAborted();
            const value = this.failure(name, error);
            this.state(name).error = value;
            connectionFailed ||= value.operation === "connect";
            if (!result.diagnostics.some((other) => other.server === name && other.code === value.code)) {
              result.diagnostics.push(value);
              result.unavailable.push(`${catalog}: ${formatDiagnostic(value)}`);
            }
          };
          if (kind === "tools" || kind === "all") {
            try { result.tools.push(...(await this.catalog(name, signal))); }
            catch (error) { record(error, "tools"); }
            result.warnings.push(...(this.state(name).warnings ?? []));
          }
          if ((kind === "resources" || kind === "all") && !connectionFailed) {
            try { result.resources.push(...(await this.resourceCatalog(name, signal))); }
            catch (error) { record(error, "resources"); }
            result.warnings.push(...(this.state(name).resourceWarnings ?? []));
            if (!connectionFailed) {
              try { result.templates!.push(...(await this.resourceCatalog(name, signal, false, true))); }
              catch (error) { record(error, "templates"); }
              result.warnings.push(...(this.state(name).templateCache?.resourceWarnings ?? []));
            }
          }
          if ((kind === "prompts" || kind === "all") && !connectionFailed) {
            try { result.prompts!.push(...(await this.promptCatalog(name, signal))); }
            catch (error) { record(error, "prompts"); }
          }
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
    /** Present server requests for input during this call. */
    ui?: ElicitationUI,
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
        "MCP tool was removed or its schema changed. Use mcp_tools with activate and its exact identifier to activate its current definition.",
      );
    const client = await waitFor(this.client(tool.server), signal);
    const state = this.state(tool.server);
    const deadline = new Deadline(config.toolTimeoutMs ?? config.timeoutMs ?? 30_000);
    const scope = ui && this.options.interactive ? { ui, deadline, progress } : undefined;
    if (scope) {
      if (!state.scopes?.size) {
        state.scopes = new Set();
        state.scopesEnded = new AbortController();
      }
      state.scopes.add(scope);
    }
    try {
      return await client.callTool(
        { name: tool.name, arguments: args },
        {
          signal: AbortSignal.any([
            this.lifetime.signal,
            deadline.signal,
            ...(signal ? [signal] : []),
          ]),
          timeout: UNBOUNDED_TIMEOUT,
          onprogress: (event) =>
            progress?.(
              event.message ??
                `${event.progress}${event.total === undefined ? "" : `/${event.total}`}`,
            ),
        },
      );
    } catch (error) {
      const context = {
        server: tool.server,
        operation: "call" as const,
        oauth: usesOAuth(config),
        signal,
      };
      // The server refused to run the tool until the user completes a browser step.
      if (scope && error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired) {
        const required = requiredElicitations(error);
        throw failure(
          required ? await this.completeRequired(tool.server, state, scope, required, signal) : "protocol_error",
          context,
        );
      }
      const value = diagnose(error, context);
      if (value.code !== "elicitation_required") state.error = value;
      throw new DiagnosticError(value);
    } finally {
      deadline.dispose();
      if (scope) {
        state.scopes?.delete(scope);
        if (!state.scopes?.size) state.scopesEnded?.abort();
      }
    }
  }

  /** Server dialogs appear one at a time, in arrival order. */
  private dialogs: Promise<unknown> = Promise.resolve();
  private dialog<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const run = this.dialogs.then(() => {
      signal.throwIfAborted();
      return work();
    });
    this.dialogs = run.catch(() => {});
    return waitFor(run, signal);
  }

  /** Accept requests only while a tool call to this server can show them. */
  private async elicit(
    name: string,
    state: ServerState,
    token: object,
    params: ElicitRequestParams,
    signal: AbortSignal,
  ): Promise<ElicitResult> {
    const scopes = [...(state.scopes ?? [])];
    const scope = scopes.at(-1);
    if (!scope || !state.scopesEnded || state.connectionToken !== token || this.closing)
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Elicitation is only accepted during an interactive tool call.");
    if ((state.pendingElicitations ?? 0) >= MAX_PENDING_ELICITATIONS)
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "Too many pending elicitation requests.");
    state.pendingElicitations = (state.pendingElicitations ?? 0) + 1;
    // Time spent answering doesn't count against this server's call deadlines.
    for (const each of scopes) each.deadline.pause();
    const combined = AbortSignal.any([signal, this.lifetime.signal, state.scopesEnded.signal]);
    try {
      return await this.dialog(() => {
        scope.progress?.("Waiting for your input…");
        return elicit(scope.ui, name, params, combined);
      }, combined);
    } catch (error) {
      if (combined.aborted) return { action: "cancel" };
      throw error;
    } finally {
      state.pendingElicitations = (state.pendingElicitations ?? 1) - 1;
      for (const each of scopes) each.deadline.resume();
      if (!combined.aborted) scope.progress?.("Calling…");
    }
  }

  /** Present a required browser step; never replay the refused call. */
  private async completeRequired(
    name: string,
    state: ServerState,
    scope: CallScope,
    required: ElicitRequestURLParams[],
    signal?: AbortSignal,
  ): Promise<"elicitation_completed" | "elicitation_declined" | "cancelled"> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const pending = new Set(required.map((item) => item.elicitationId));
    const completed = new AbortController();
    const awaiting = state.awaitingCompletion ??= new Map();
    const listeners = new Map<string, () => void>();
    for (const id of pending) {
      const complete = () => {
        pending.delete(id);
        if (!pending.size) completed.abort();
      };
      listeners.set(id, complete);
      const subscribers = awaiting.get(id) ?? new Set<() => void>();
      subscribers.add(complete);
      awaiting.set(id, subscribers);
    }
    try {
      for (const params of required) {
        scope.progress?.("Waiting for your input…");
        const result = await this.dialog(() => elicit(scope.ui, name, params, combined), combined);
        if (result.action !== "accept") return combined.aborted ? "cancelled" : "elicitation_declined";
      }
      const done = completed.signal.aborted ||
        await this.dialog(() => awaitCompletion(scope.ui, name, completed.signal, combined), combined);
      return done ? "elicitation_completed" : combined.aborted ? "cancelled" : "elicitation_declined";
    } catch {
      // Aborted dialogs, or a URL the dialog refused before asking.
      return combined.aborted ? "cancelled" : "elicitation_declined";
    } finally {
      for (const [id, complete] of listeners) {
        const subscribers = awaiting.get(id);
        subscribers?.delete(complete);
        if (!subscribers?.size) awaiting.delete(id);
      }
    }
  }

  /** Close related OAuth connections without reconnecting, including disabled servers. */
  async disconnect(names: string[]): Promise<void> {
    for (const name of names) {
      const state = this.states.get(name);
      if (state?.connecting || state?.listing || state?.resourceListing || state?.templateCache?.resourceListing || state?.promptListing)
        throw failure("busy", { server: name, operation: "auth" });
    }
    await Promise.all(names.map(async (name) => {
      this.scopeChallenges.delete(name);
      const state = this.states.get(name);
      if (!state) return;
      state.connectionToken = undefined;
      await state.subscriptions?.close();
      state.subscriptions = undefined;
      state.catalogGeneration++;
      const identity = state.identity ?? state.connectionIdentity;
      await state.client?.autoOpenedSubscription?.close().catch(() => {});
      await state.client?.close().catch(() => {});
      await state.transport?.close().catch(() => {});
      await state.invalidating;
      this.states.delete(name);
      if (identity) {
        const path = join(this.cacheDir, `${identity}.json`);
        await withFileMutationQueue(path, () => rm(path, { force: true })).catch(() => {});
      }
    }));
  }

  async reconnect(name: string): Promise<void> {
    this.definition(name);
    const state = this.state(name);
    if (state.connecting || state.listing || state.resourceListing || state.templateCache?.resourceListing || state.promptListing)
      throw failure("busy", { server: name, operation: "reconnect" });
    await state.subscriptions?.close();
    state.subscriptions = undefined;
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
          : state?.connecting || state?.listing || state?.resourceListing || state?.templateCache?.resourceListing || state?.promptListing ? "connecting"
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
    this.scopeChallenges.clear();
    await this.clearResourceSubscriptions();
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
        await state.promptListing?.catch(() => {});
        await state.resourceListing?.catch(() => {});
        await state.templateCache?.resourceListing?.catch(() => {});
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
          oauth: this.config[name] && usesOAuth(this.config[name]),
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
