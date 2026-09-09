import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAuthProvider, OAuthProvider, type SecretStore } from "../src/auth.js";
import { parseConfig, resolveServer, usesOAuth, type ServerConfig } from "../src/config.js";
import { failure } from "../src/diagnostics.js";
import { createSdkConnector, McpRuntime } from "../src/runtime.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function memoryStore(): SecretStore {
  let record: string | null = null;
  return { read: () => record, write: (value) => { record = value; }, remove: () => { record = null; } };
}

test("OAuth inference honors Authorization headers", async () => {
  for (const config of [{ command: "server" },
    { url: "https://example.com", headers: { aUtHoRiZaTiOn: "Bearer private" } }]) {
    expect(usesOAuth(config)).toBe(false);
    expect(await connectionAuthProvider(config, async () => { throw new Error("must not touch credentials"); })).toBeUndefined();
  }
  expect(usesOAuth({ url: "https://example.com" })).toBe(true);
  for (const oauth of [true, false])
    expect(() => parseConfig({ mcpServers: { example: { url: "https://example.com", oauth } } })).toThrow("remove oauth");
  for (const options of [{ oauthClientId: "client" }, { oauthScopes: ["read"] }, { oauthCallbackPort: 12345 }]) {
    const definition = { url: "https://example.com", ...options };
    expect(parseConfig({ mcpServers: { example: definition } }).example).toEqual(definition);
    expect(() => resolveServer({ ...definition, headers: { Authorization: "private" } }, "/")).toThrow("not both");
    expect(() => parseConfig({ mcpServers: { example: { command: "server", ...options } } })).toThrow();
  }
});

test("automatic credentials fail closed if a previously available store becomes locked", async () => {
  const store = memoryStore();
  const provider = await connectionAuthProvider({ url: "https://example.com/mcp" }, async () => store);
  expect(await provider!.tokens()).toBeUndefined();
  store.read = () => { throw failure("credential_store_unavailable", { operation: "auth" }); };
  await expect(provider!.tokens()).rejects.toThrow("credential_store_unavailable");
});

for (const protocol of ["auto", "legacy"] as const) for (const scenario of [
  "public", "public-locked", "stored-token", "refresh", "no-grant", "locked", "corrupt", "header",
] as const) {
  test(`SDK automatic OAuth: ${scenario} (${protocol})`, async () => {
    const store = memoryStore();
    let base = "";
    let accesses = 0;
    let registrations = 0;
    let authorizations = 0;
    let refreshes = 0;
    const headers: (string | null)[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`, response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
      if (path === "/register") { registrations++; return new Response("Unexpected registration", { status: 500 }); }
      if (path === "/authorize") { authorizations++; return new Response("Unexpected authorization", { status: 500 }); }
      if (path === "/token") {
        refreshes++;
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("private-refresh");
        return Response.json({ access_token: "private-valid", token_type: "Bearer" });
      }
      if (path !== "/mcp") return new Response(null, { status: 404 });
      const header = request.headers.get("authorization");
      headers.push(header);
      const publicServer = scenario === "public" || scenario === "public-locked";
      if (!publicServer && header !== "Bearer private-valid")
        return new Response("private-error", { status: 401, headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        } });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = await request.json() as any;
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    } });
    base = `http://127.0.0.1:${server.port}`;
    cleanup.push(async () => { await server.stop(true); });
    const url = `${base}/mcp`;
    if (["stored-token", "refresh", "header"].includes(scenario)) {
      const provider = new OAuthProvider(url, store);
      provider.saveClientInformation({ client_id: "fixture-client", issuer: base }, { issuer: base });
      provider.saveTokens({ access_token: scenario === "refresh" ? "private-expired" : "private-valid", token_type: "Bearer", issuer: base,
        ...(scenario === "refresh" ? { refresh_token: "private-refresh" } : {}) });
    }
    if (scenario === "corrupt") store.write("private-corrupt-record");
    const config: ServerConfig = { url, protocol,
      ...(scenario === "header" ? { headers: { aUtHoRiZaTiOn: "Bearer private-valid" } } : {}),
    };
    const directory = await mkdtemp(join(tmpdir(), "mcp-auto-oauth-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const runtime = new McpRuntime({ example: config }, directory, join(directory, "cache"), createSdkConnector(async () => {
      accesses++;
      if (scenario === "locked" || scenario === "public-locked") throw failure("credential_store_unavailable", { operation: "auth" });
      return store;
    }));
    cleanup.push(() => runtime.close());
    const result = await runtime.discover();
    const error = scenario === "no-grant" ? "authentication_required"
      : scenario === "locked" ? "credential_store_unavailable" : scenario === "corrupt" ? "connection_failed" : undefined;
    if (error) {
      expect(result.diagnostics[0]?.code).toBe(error);
      expect(JSON.stringify(result)).not.toContain("private-");
    } else expect(result.diagnostics).toEqual([]);
    expect(registrations).toBe(0);
    expect(authorizations).toBe(0);
    expect(refreshes).toBe(scenario === "refresh" ? 1 : 0);
    expect(accesses).toBe(scenario === "header" ? 0 : 1);
    if (scenario === "stored-token") expect(headers[0]).toBe("Bearer private-valid");
    if (scenario === "public" || scenario === "public-locked") expect(headers.every((value) => value === null)).toBe(true);
  });
}
