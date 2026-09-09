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
import { fingerprint, object } from "./config.js";
import { diagnose, DiagnosticError, failure } from "./diagnostics.js";

const REDIRECT = "http://127.0.0.1:19847/callback";
interface Credentials {
  url: string;
  clientId?: string;
  clients: Record<string, StoredOAuthClientInformation>;
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
  readonly redirectUrl = REDIRECT;
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: "Pi MCP Client",
    redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
  };
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
  ) {
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
    if (!this.clientId) return stored;
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
    this.data.clients = { ...this.data.clients, [ctx.issuer]: info };
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
    if (scope === "all" || scope === "client") this.data.clients = {};
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

/** Explicit user action only; OAuth never opens a browser during search or execution. */
export async function authenticate(
  url: string,
  open: (url: string) => Promise<void>,
  signal?: AbortSignal,
  store?: SecretStore,
  clientId?: string,
): Promise<void> {
  const provider = new OAuthProvider(
    url,
    store ?? (await credentialStore(url, clientId)),
    (target) => open(target.href),
    clientId,
  );
  const deadline = AbortSignal.any([
    AbortSignal.timeout(120_000),
    ...(signal ? [signal] : []),
  ]);
  let resolveCallback!: (params: URLSearchParams) => void;
  const callback = new Promise<URLSearchParams>((resolve) => {
    resolveCallback = resolve;
  });
  const server = createServer((req, res) => {
    const target = new URL(req.url ?? "/", REDIRECT);
    if (
      req.method !== "GET" ||
      target.pathname !== "/callback" ||
      target.searchParams.get("state") !== provider.expectedState
    ) {
      res.writeHead(400).end("Invalid OAuth callback.");
      return;
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end("Authorization response received. Return to Pi.");
    resolveCallback(target.searchParams);
  });
  const fetchFn = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, {
      ...init,
      signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
    });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(19847, "127.0.0.1", resolve);
    });
    deadline.throwIfAborted();
    // Explicit login offers a fresh grant, rather than silently refreshing the old one.
    const result = await auth(provider, { serverUrl: url, fetchFn, forceReauthorization: true });
    if (result === "AUTHORIZED") return;
    const params = await new Promise<URLSearchParams>((resolve, reject) => {
      const abort = () =>
        reject(
          failure(signal?.aborted ? "cancelled" : "timeout", { operation: "auth" }),
        );
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
      void callback.then((value) => {
        deadline.removeEventListener("abort", abort);
        resolve(value);
      });
    });
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
