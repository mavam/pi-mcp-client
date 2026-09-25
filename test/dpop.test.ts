import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { accessTokenHash } from "@modelcontextprotocol/client";
import { authenticate, OAuthProvider, logout, connectionAuthProvider, type SecretStore } from "../src/auth.js";
import { McpRuntime, createSdkConnector } from "../src/runtime.js";
import { parseConfig, resolveServer } from "../src/config.js";
import { parseConfigCommand } from "../src/config-commands.js";
import { failure } from "../src/diagnostics.js";
import { inspectServer } from "../src/management.js";

function memoryStore(): SecretStore {
  let value: string | null = null;
  return { read: () => value, write: record => { value = record; }, remove: () => { value = null; } };
}

async function login(identity: { server: string; url: string; clientId?: string }, store: SecretStore, enabled = true) {
  await authenticate(identity, async () => { throw new Error("No browser"); }, undefined, store, {
    oauthDpop: enabled, handoff: async target => {
      const url = new URL(target);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "approved");
      return callback.href;
    },
  });
}

async function service(bearer = false, dynamic = false) {
  let issuer = "", resource = "", advertisedIssuer = "";
  const proofs: string[] = [];
  const grants = new Map<string, string>();
  const rejected = new Set<string>();
  const attempts = { token: 0, resource: 0, executed: 0, refresh: 0, register: 0 };
  const verify = async (request: Request, token?: string) => {
    const proof = request.headers.get("dpop")!;
    expect(proof).toBeTruthy();
    expect(proofs).not.toContain(proof);
    proofs.push(proof);
    const header = decodeProtectedHeader(proof);
    expect(header.typ).toBe("dpop+jwt");
    expect(header.alg).toBe("ES256");
    expect(Object.keys(header.jwk ?? {})).not.toContain("d");
    const key = await importJWK(header.jwk!, "ES256");
    const { payload } = await jwtVerify(proof, key, { algorithms: ["ES256"] });
    expect(payload.htm).toBe(request.method);
    expect(payload.htu).toBe(request.url.split("?")[0]);
    expect(typeof payload.jti).toBe("string");
    expect(payload.ath).toBe(token ? await accessTokenHash(token) : undefined);
    return { payload, thumbprint: await calculateJwkThumbprint(header.jwk!) };
  };
  const as = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-authorization-server") return Response.json({ issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], dpop_signing_alg_values_supported: ["ES256"],
      ...(dynamic ? { registration_endpoint: `${issuer}/register` } : {}) });
    if (path === "/register") {
      attempts.register++;
      return Response.json({ ...await request.json() as object, client_id: "dynamic-client" }, { status: 201 });
    }
    if (path !== "/token") return new Response(null, { status: 404 });
    attempts.token++;
    const proof = await verify(request);
    if (proof.payload.nonce !== "as-nonce") return Response.json({ error: "use_dpop_nonce", error_description: "private-payload" }, {
      status: 400, headers: { "DPoP-Nonce": "as-nonce" },
    });
    const params = new URLSearchParams(await request.text());
    if (params.get("grant_type") === "refresh_token") {
      attempts.refresh++;
      expect(params.get("refresh_token")).toBe(`refresh:${proof.thumbprint}`);
    }
    const token = `access-${grants.size}`;
    grants.set(token, proof.thumbprint);
    return Response.json({ access_token: token, refresh_token: `refresh:${proof.thumbprint}`, token_type: bearer ? "Bearer" : "DPoP" });
  } });
  issuer = `http://127.0.0.1:${as.port}`;
  const rs = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${resource}/mcp`, authorization_servers: [advertisedIssuer || issuer] });
    attempts.resource++;
    const authorization = request.headers.get("authorization")!;
    expect(authorization?.startsWith(bearer ? "Bearer " : "DPoP ")).toBe(true);
    const token = authorization.split(" ")[1];
    if (!bearer) {
      const proof = await verify(request, token);
      expect(grants.get(token)).toBe(proof.thumbprint);
      if (proof.payload.nonce !== "rs-nonce") return new Response(null, { status: 401, headers: {
        "WWW-Authenticate": 'DPoP error="use_dpop_nonce"', "DPoP-Nonce": "rs-nonce",
      } });
    } else expect(request.headers.has("dpop")).toBe(false);
    if (rejected.has(token)) return new Response(null, { status: 401, headers: {
      "WWW-Authenticate": `DPoP error="invalid_token", resource_metadata="${resource}/.well-known/oauth-protected-resource"`,
    } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as any;
    if (message.id === undefined) return new Response(null, { status: 202 });
    attempts.executed++;
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "dpop", version: "1" } }
      : { tools: [] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  resource = `http://127.0.0.1:${rs.port}`;
  return { identity: { server: "example", url: `${resource}/mcp`, clientId: dynamic ? undefined : "client" }, attempts, rejected,
    issuer, changeIssuer: (value: string) => { advertisedIssuer = value; },
    stop: async () => { await rs.stop(true); await as.stop(true); } };
}

for (const bearer of [false, true]) test(`SDK DPoP round trip, persistence, nonce retries and refresh (Bearer=${bearer})`, async () => {
  const f = await service(bearer);
  const store = memoryStore();
  const directory = await mkdtemp(join(tmpdir(), "mcp-dpop-"));
  const config = { url: f.identity.url, oauthClientId: "client", oauthDpop: true, protocol: "legacy" as const };
  let runtime: McpRuntime | undefined;
  try {
    await login(f.identity, store);
    const record = JSON.parse(store.read()!);
    expect(record.dpopKey.issuer).toBeTruthy();
    expect(record.dpopKey.clientId).toBe("client");
    expect(record.dpopKey.privateJwk.d).toBeTruthy();
    const storedKey = JSON.stringify(record.dpopKey);
    f.rejected.add(record.tokens.access_token);
    runtime = new McpRuntime({ example: config }, directory, directory, createSdkConnector(async () => store));
    expect((await runtime.discover()).diagnostics).toEqual([]);
    expect(f.attempts.refresh).toBe(1);
    expect(JSON.stringify(JSON.parse(store.read()!).dpopKey)).toBe(storedKey);
    const provider = new OAuthProvider(f.identity, store, undefined, config);
    expect(await provider.dpop()).toBe(await provider.dpop());
    const stale = await connectionAuthProvider("example", config, async () => store);
    await stale!.dpop!();
    await runtime.close(); runtime = undefined;
    await logout(f.identity, store);
    expect(store.read()).toBeNull();
    await expect(stale!.dpop!()).rejects.toThrow("authentication_required");
  } finally { await runtime?.close(); await f.stop(); await rm(directory, { recursive: true, force: true }); }
}, 15_000);

for (const bearer of [false, true]) for (const defect of ["missing", "corrupt", "disabled", "client-mismatch", "issuer-mismatch"] as const) test(`DPoP fails closed with ${defect} key state (Bearer=${bearer})`, async () => {
  const f = await service(bearer); const store = memoryStore();
  const directory = await mkdtemp(join(tmpdir(), "mcp-dpop-key-"));
  let runtime: McpRuntime | undefined;
  try {
    await login(f.identity, store);
    const data = JSON.parse(store.read()!);
    if (defect === "missing") delete data.dpopKey;
    if (defect === "corrupt") data.dpopKey.privateJwk.d = "broken";
    if (defect === "client-mismatch") data.dpopKey.clientId = "other";
    if (defect === "issuer-mismatch") data.dpopKey.issuer = "https://other.example";
    store.write(JSON.stringify(data));
    const original = store.read();
    expect(data.dpopRefreshBound).toBe(true);
    runtime = new McpRuntime({ example: { url: f.identity.url, oauthClientId: "client", oauthDpop: defect !== "disabled", protocol: "legacy" } }, directory, directory, createSdkConnector(async () => store));
    const result = await runtime.discover();
    expect(result.diagnostics[0]?.code).toBe(defect === "issuer-mismatch" ? "oauth_issuer_changed" : "oauth_dpop_unavailable");
    expect(f.attempts.resource).toBe(0);
    expect(f.attempts.refresh).toBe(0);
    expect(store.read()).toBe(original);
    expect(JSON.stringify(result)).not.toContain(data.tokens.access_token);
    if (defect === "missing") { await login(f.identity, store); expect(JSON.parse(store.read()!).dpopKey).toBeDefined(); }
  } finally { await runtime?.close(); await f.stop(); await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("dynamic DPoP grants retain their issuer pin after key loss", async () => {
  const a = await service(false, true), b = await service(false, true);
  const store = memoryStore();
  try {
    await login(a.identity, store);
    const data = JSON.parse(store.read()!);
    expect(data.grantIssuer).toBe(a.issuer);
    delete data.dpopKey;
    store.write(JSON.stringify(data));
    const original = store.read();
    a.changeIssuer(b.issuer);
    await expect(login(a.identity, store)).rejects.toThrow("oauth_issuer_changed");
    expect(b.attempts.register).toBe(0);
    expect(store.read()).toBe(original);
    a.changeIssuer(a.issuer);
    await login(a.identity, store);
    expect(JSON.parse(store.read()!).dpopKey.issuer).toBe(a.issuer);
    a.changeIssuer(b.issuer);
    await logout(a.identity, store);
    await login(a.identity, store);
    expect(b.attempts.register).toBe(1);
    expect(JSON.parse(store.read()!).grantIssuer).toBe(b.issuer);
  } finally { await a.stop(); await b.stop(); }
}, 15_000);

test("DPoP configuration is explicit, OAuth-only, and safe to inspect", async () => {
  const config = { url: "https://example.com/mcp", oauthDpop: true };
  expect(parseConfig({ mcpServers: { example: config } }).example).toEqual(config);
  for (const definition of [{ ...config, oauthDpop: "true" }, { command: "server", oauthDpop: true }])
    expect(() => parseConfig({ mcpServers: { example: definition } })).toThrow();
  expect(() => resolveServer({ ...config, headers: { Authorization: "private" } }, "/")).toThrow("not both");
  const command = parseConfigCommand("add --scope global --oauth-dpop example https://example.com/mcp");
  expect(command?.action === "add" && command.definition.oauthDpop).toBe(true);
  expect(() => parseConfigCommand("add --scope global --oauth-dpop example -- server")).toThrow();
  expect(inspectServer("example", config, "idle")).toContain("DPoP: enabled");
  const store = memoryStore();
  const provider = await connectionAuthProvider("example", config, async () => store);
  expect(await provider!.dpop!()).toBeUndefined();
  expect(store.read()).toBeNull();
  const locked = await connectionAuthProvider("example", config, async () => { throw failure("credential_store_unavailable", { operation: "auth" }); });
  expect(await locked!.dpop!()).toBeUndefined();
});
