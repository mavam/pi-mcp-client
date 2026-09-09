import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { fingerprint, object, type ClientOptions } from "./config.js";
import { oauthCallbackHtml } from "./oauth-page.js";
import { diagnose, DiagnosticError, failure } from "./diagnostics.js";

const REDIRECT = "http://127.0.0.1:19847/callback";
export type OAuthOptions = Pick<ClientOptions, "oauthScopes" | "oauthCallbackPort">;
export function callbackUrl(options: OAuthOptions = {}): string {
  return `http://127.0.0.1:${options.oauthCallbackPort ?? 19847}/callback`;
}

/** Validate the full handoff URL before giving the response to the SDK. */
export function parseCallback(value: string, redirect: string, state: string): URLSearchParams {
  const invalid = () => failure("oauth_failed", { operation: "auth" });
  if (value.length > 16_384 || /[\u0000-\u0020\u007f]/u.test(value)) throw invalid();
  let target: URL;
  try { target = new URL(value); } catch { throw invalid(); }
  const expected = new URL(redirect);
  const params = target.searchParams;
  if (target.origin !== expected.origin || target.pathname !== expected.pathname ||
      target.username || target.password || target.hash ||
      [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
      params.get("state") !== state ||
      (params.has("code") === params.has("error")) ||
      !(params.get("code") || params.get("error"))) throw invalid();
  return params;
}
interface Credentials {
  url: string;
  clientId?: string;
  clients: Record<string, StoredOAuthClientInformation>;
  registrations?: Record<string, { redirect: string; scope?: string }>;
  tokens?: StoredOAuthTokens;
}
export interface SecretStore {
  read(): string | null;
  write(value: string): void;
  remove(): void;
}
export type CredentialStoreFactory = (url: string, clientId?: string) => Promise<SecretStore>;

export function credentialKey(url: string, clientId?: string): string {
  return fingerprint({ url, redirect: REDIRECT, clientId });
}

// Invalidate even providers created before a login has saved its first record.
const credentialEpochs = new Map<string, number>();

export async function credentialStore(url: string, clientId?: string): Promise<SecretStore> {
  // Loaded only for OAuth servers. Fail closed if the OS store is unavailable.
  const protect = <T>(action: () => T): T => {
    try {
      return action();
    } catch {
      throw failure("credential_store_unavailable", { operation: "auth" });
    }
  };
  try {
    const { Entry } = await import("@napi-rs/keyring");
    const entry = new Entry("pi-mcp-client", credentialKey(url, clientId));
    return {
      read: () => protect(() => entry.getPassword()),
      write: (value) => protect(() => entry.setPassword(value)),
      remove: () => protect(() => { entry.deleteCredential(); }),
    };
  } catch {
    throw failure("credential_store_unavailable", { operation: "auth" });
  }
}

export class OAuthProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  private data: Credentials;
  private snapshot: string | null;
  private readonly epoch: number;
  private readonly key: string;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  readonly expectedState = randomUUID();
  constructor(
    readonly url: string,
    private readonly store: SecretStore,
    private readonly redirect?: (url: URL) => void | Promise<void>,
    private readonly clientId?: string,
    options: OAuthOptions = {},
  ) {
    this.redirectUrl = callbackUrl(options);
    this.clientMetadata = {
      client_name: "Pi MCP Client",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      ...(options.oauthScopes ? { scope: options.oauthScopes.join(" ") } : {}),
    };
    this.key = credentialKey(url, clientId);
    this.epoch = credentialEpochs.get(this.key) ?? 0;
    const raw = store.read();
    this.snapshot = raw;
    if (raw) {
      const data: unknown = JSON.parse(raw);
      if (
        !object(data) ||
        data.url !== url ||
        data.clientId !== clientId ||
        !object(data.clients) ||
        (data.tokens !== undefined &&
          (!object(data.tokens) || typeof data.tokens.access_token !== "string"))
      )
        throw new Error("Invalid OAuth credential record.");
      this.data = data as unknown as Credentials;
    } else this.data = { url, clientId, clients: {} };
  }
  private assertCurrent() {
    if ((credentialEpochs.get(this.key) ?? 0) !== this.epoch || this.store.read() !== this.snapshot)
      throw failure("authentication_required", { operation: "auth", oauth: true });
  }
  private save() {
    // Never let a late refresh resurrect credentials removed by another provider.
    this.assertCurrent();
    const record = JSON.stringify(this.data);
    this.store.write(record);
    this.snapshot = record;
  }
  state() {
    return this.expectedState;
  }
  clientInformation(ctx?: OAuthClientInformationContext) {
    this.assertCurrent();
    if (!ctx) return undefined;
    const stored = Object.hasOwn(this.data.clients, ctx.issuer) ? this.data.clients[ctx.issuer] : undefined;
    if (!this.clientId) {
      // Fresh explicit grants must use a registration matching the requested
      // callback and scopes. Refresh/logout still use the stored client.
      const registration = this.data.registrations?.[ctx.issuer];
      if (this.redirect && stored &&
          ((registration?.redirect ?? REDIRECT) !== this.redirectUrl ||
            registration?.scope !== this.clientMetadata.scope))
        return undefined;
      return stored;
    }
    // A configured public ID is not a secret, but a successful grant pins it to
    // its issuer. Require explicit logout before trusting a replacement issuer.
    if ((this.data.tokens?.issuer && this.data.tokens.issuer !== ctx.issuer) ||
        (Object.keys(this.data.clients).length && !stored))
      throw failure("oauth_issuer_changed", { operation: "auth", oauth: true });
    return { client_id: this.clientId, issuer: ctx.issuer };
  }
  saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext,
  ) {
    if (!ctx) throw new Error("OAuth client registration has no issuer.");
    if (this.clientId && (info.client_id !== this.clientId || info.client_secret))
      throw new Error("Cannot replace the configured public OAuth client.");
    const previous = this.data.clients[ctx.issuer];
    if (!this.clientId && previous && previous.client_id !== info.client_id &&
        this.data.tokens?.issuer === ctx.issuer)
      delete this.data.tokens; // A replacement registration cannot refresh the old client's grant.
    this.data.clients = { ...this.data.clients, [ctx.issuer]: info };
    if (!this.clientId) this.data.registrations = {
      ...this.data.registrations,
      [ctx.issuer]: { redirect: this.redirectUrl, scope: this.clientMetadata.scope },
    };
    this.save();
  }
  tokens(ctx?: OAuthClientInformationContext) {
    this.assertCurrent();
    const tokens = this.data.tokens;
    return !ctx || tokens?.issuer === ctx.issuer ? tokens : undefined;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    if (this.clientId) {
      if (!tokens.issuer) throw new Error("OAuth tokens have no issuer.");
      const info = this.clientInformation({ issuer: tokens.issuer })!;
      this.data.clients = { ...this.data.clients, [tokens.issuer]: info };
    }
    this.data.tokens = tokens;
    this.save();
  }
  saveCodeVerifier(value: string) {
    this.verifier = value;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error("Missing OAuth verifier.");
    return this.verifier;
  }
  saveDiscoveryState(value: OAuthDiscoveryState) {
    this.discovery = value;
  }
  discoveryState() {
    return this.discovery;
  }
  async redirectToAuthorization(url: URL) {
    if (!this.redirect)
      throw failure("authentication_required", { operation: "connect", oauth: true });
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new Error("Refusing an insecure authorization URL.");
    await this.redirect(url);
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "client") {
      this.data.clients = {};
      delete this.data.registrations;
    }
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    if (scope === "all" || scope === "discovery") this.discovery = undefined;
    this.save();
  }
}

export type Revocation = "confirmed" | "unsupported" | "unconfirmed" | "not-needed";

/** Local removal is unconditional; revocation is bounded, issuer-bound, and best effort. */
export async function logout(
  url: string,
  store: SecretStore,
  signal?: AbortSignal,
  clientId?: string,
): Promise<Revocation> {
  let tokens: StoredOAuthTokens | undefined;
  let client: StoredOAuthClientInformation | undefined;
  let readable = true;
  try {
    const provider = new OAuthProvider(url, store, undefined, clientId);
    tokens = provider.tokens();
    if (tokens?.issuer) client = provider.clientInformation({ issuer: tokens.issuer });
  } catch {
    // Corrupt records must still be removable. Never render the raw record/error.
    readable = false;
  }
  store.remove();
  const key = credentialKey(url, clientId);
  credentialEpochs.set(key, (credentialEpochs.get(key) ?? 0) + 1);
  if (!readable) return "unconfirmed";
  if (!tokens) return "not-needed";
  if (!tokens.issuer || !client) return "unconfirmed";
  const deadline = AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => fetch(input, {
    ...init,
    signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
  });
  try {
    const info = await discoverOAuthServerInfo(url, { fetchFn });
    const metadata = info.authorizationServerMetadata;
    if (info.authorizationServerUrl !== tokens.issuer || metadata?.issuer !== tokens.issuer)
      return "unconfirmed";
    const endpoint = "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
    if (typeof endpoint !== "string") return "unsupported";
    const target = new URL(endpoint);
    if (target.username || target.password || target.hash ||
        (target.protocol !== "https:" && !(target.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))))
      return "unconfirmed";
    // Only public clients are supported. Do not guess a confidential auth method.
    if (client.client_secret) return "unconfirmed";
    for (const [hint, token] of [
      ["refresh_token", tokens.refresh_token],
      ["access_token", tokens.access_token],
    ] as const) {
      if (!token) continue;
      const response = await fetchFn(target, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id }),
      });
      await response.body?.cancel();
      if (!response.ok) return "unconfirmed";
    }
    return "confirmed";
  } catch {
    return "unconfirmed";
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Explicit user action only; OAuth never opens a browser during search or execution. */
export async function authenticate(
  url: string,
  open: (url: string) => Promise<void>,
  signal?: AbortSignal,
  store?: SecretStore,
  clientId?: string,
  options: OAuthOptions & {
    handoff?: (authorizationUrl: string, signal: AbortSignal) => Promise<string | undefined>;
  } = {},
): Promise<void> {
  const deadline = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(signal ? [signal] : []),
  ]);
  let resolveCallback!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  const provider = new OAuthProvider(
    url,
    store ?? (await credentialStore(url, clientId)),
    async (target) => {
      deadline.throwIfAborted();
      if (!options.handoff) return open(target.href);
      const value = await waitFor(options.handoff(target.href, deadline), deadline);
      deadline.throwIfAborted();
      if (value === undefined) throw failure("cancelled", { operation: "auth" });
      resolveCallback(parseCallback(value.trim(), provider.redirectUrl, provider.expectedState));
    },
    clientId,
    options,
  );
  let received = false;
  const server = options.handoff ? undefined : createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    let params: URLSearchParams;
    try {
      if (received || req.method !== "GET" || req.headers.host !== new URL(provider.redirectUrl).host ||
          !req.url?.startsWith("/callback?")) throw new Error("Invalid callback");
      params = parseCallback(new URL(req.url, provider.redirectUrl).href, provider.redirectUrl, provider.expectedState);
    } catch {
      res.writeHead(400).end(oauthCallbackHtml("invalid"));
      return;
    }
    received = true;
    res.end(oauthCallbackHtml(params.has("error") ? "denied" : "received"));
    resolveCallback(params);
  });
  const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
    });
  try {
    deadline.throwIfAborted();
    if (server) await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.oauthCallbackPort ?? 19847, "127.0.0.1", resolve);
    });
    deadline.throwIfAborted();
    // Explicit login offers a fresh grant, rather than silently refreshing the old one.
    const result = await auth(provider, {
      serverUrl: url, fetchFn, forceReauthorization: true,
      scope: options.oauthScopes?.join(" "),
    });
    if (result === "AUTHORIZED") return;
    const params = await waitFor(callback, deadline);
    if (params.has("error") || !params.get("code"))
      throw new Error("OAuth authorization was not granted.");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/client"
    );
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider: provider,
      fetch: fetchFn,
    });
    try {
      await transport.finishAuth(params);
    } finally {
      await transport.close();
    }
  } catch (error) {
    throw new DiagnosticError(diagnose(error, { operation: "auth", signal: deadline }));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
