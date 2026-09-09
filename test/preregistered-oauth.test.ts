import { expect, test } from "bun:test";
import { auth } from "@modelcontextprotocol/client";
import { authenticate, credentialKey, logout, OAuthProvider, type SecretStore } from "../src/auth.js";
import { fingerprint, parseConfig, resolveServer } from "../src/config.js";
import { authenticationSummary } from "../src/management.js";

function memoryStore(): SecretStore {
  let record: string | null = null;
  return {
    read: () => record,
    write: (value) => { record = value; },
    remove: () => { record = null; },
  };
}

test("pre-registered client IDs require HTTP OAuth and never execute commands", () => {
  for (const definition of [
    { command: "fixture", oauthClientId: "client" },
    ...["", " ", "bad\nclient", 42, {}, "x".repeat(4097)].map((oauthClientId) => ({ url: "https://example.com", oauthClientId })),
    { url: "https://example.com", oauthClientSecret: "not-supported" },
  ]) expect(() => parseConfig({ mcpServers: { example: definition } })).toThrow();
  const config = parseConfig({ mcpServers: { example: { url: "https://example.com", oauthClientId: "!literal-client-id" } } });
  expect(resolveServer(config.example, "/").oauthClientId).toBe("!literal-client-id");
  process.env.MCP_TEST_CLIENT_ID = "registered-client";
  try {
    expect(resolveServer({ url: "https://example.com", oauthClientId: "${MCP_TEST_CLIENT_ID}" }, "/").oauthClientId).toBe("registered-client");
    process.env.MCP_TEST_CLIENT_ID = " ";
    expect(() => resolveServer({ url: "https://example.com", oauthClientId: "${MCP_TEST_CLIENT_ID}" }, "/")).toThrow();
  } finally { delete process.env.MCP_TEST_CLIENT_ID; }
});

test("credential identities depend only on server URL and configured client", async () => {
  const url = "https://identity.example/mcp";
  expect(credentialKey(url)).toBe(fingerprint({ url }));
  expect(new Set([credentialKey(url), credentialKey(url, "one"), credentialKey(url, "two"), credentialKey(`${url}/other`, "one")]).size).toBe(4);
  const one = memoryStore();
  const two = memoryStore();
  const provider = new OAuthProvider(url, one, undefined, "one");
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer", issuer: "https://issuer.example" });
  expect(() => new OAuthProvider(url, one, undefined, "two")).toThrow("Invalid OAuth credential record");
  expect(() => new OAuthProvider(url, one)).toThrow("Invalid OAuth credential record");
  const second = new OAuthProvider(url, two, undefined, "two");
  await logout(url, two, undefined, "two");
  expect(provider.tokens()?.access_token).toBe("private-token");
  expect(() => second.tokens()).toThrow("authentication_required");
  const summary = await authenticationSummary({ url, oauthClientId: "one" }, "/", async (resolved, id) => {
    expect(resolved).toBe(url); expect(id).toBe("one"); return one;
  });
  expect(summary).toBe("OAuth (pre-registered public client) · stored tokens (validity not checked)");
  expect(summary).not.toContain("private-token");
});

test("configured clients stay issuer-bound and cannot be overwritten by dynamic registration", () => {
  const store = memoryStore();
  const provider = new OAuthProvider("https://binding.example/mcp", store, undefined, "registered-client");
  const issuer = "https://issuer.example";
  expect(provider.clientInformation({ issuer })).toEqual({ client_id: "registered-client", issuer });
  expect(store.read()).toBeNull();
  expect(() => provider.saveTokens({ access_token: "private-token", token_type: "Bearer" })).toThrow("no issuer");
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer", issuer });
  expect(provider.tokens({ issuer: "https://changed.example" })).toBeUndefined();
  expect(() => provider.clientInformation({ issuer: "https://changed.example" })).toThrow("oauth_issuer_changed");
  expect(() => provider.saveClientInformation({ client_id: "other", issuer }, { issuer })).toThrow("Cannot replace");
  expect(() => provider.saveClientInformation({ client_id: "registered-client", client_secret: "secret", issuer }, { issuer })).toThrow("Cannot replace");
  provider.invalidateCredentials("client");
  provider.invalidateCredentials("tokens");
  expect(provider.clientInformation({ issuer })?.client_id).toBe("registered-client");
});

for (const rejectClient of [false, true]) {
  test(`SDK pre-registered public client flow without dynamic registration (rejected=${rejectClient})`, async () => {
    const store = memoryStore();
    let base = "";
    let registrations = 0;
    let authorizations = 0;
    let refreshes = 0;
    const revoked: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (path === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
            revocation_endpoint: `${base}/revoke`, response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
            // Deliberately no registration_endpoint.
          });
        if (path === "/register") { registrations++; return new Response("Unexpected", { status: 500 }); }
        if (path === "/token") {
          const params = new URLSearchParams(await request.text());
          expect(params.get("client_id")).toBe("registered-client");
          expect(params.has("client_secret")).toBe(false);
          expect(request.headers.has("Authorization")).toBe(false);
          if (rejectClient) return Response.json({ error: "invalid_client", error_description: "private-error" }, { status: 400 });
          if (params.get("grant_type") === "refresh_token") refreshes++;
          else { authorizations++; expect(params.get("code_verifier")).toBeTruthy(); }
          return Response.json({ access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer" });
        }
        if (path === "/revoke") {
          const params = new URLSearchParams(await request.text());
          expect(params.get("client_id")).toBe("registered-client");
          revoked.push(params.get("token")!);
          return new Response("");
        }
        return new Response("Not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    const url = `${base}/mcp`;
    let browserOpens = 0;
    const open = async (target: string) => {
      browserOpens++;
      const authorization = new URL(target);
      expect(authorization.searchParams.get("client_id")).toBe("registered-client");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "private-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      callback.searchParams.set("iss", base);
      expect((await fetch(callback)).status).toBe(200);
    };
    try {
      if (rejectClient) {
        await expect(authenticate(url, open, AbortSignal.timeout(10_000), store, "registered-client")).rejects.toThrow("oauth_failed");
        expect(store.read()).not.toContain("private-error");
        expect(new OAuthProvider(url, store, undefined, "registered-client").tokens()).toBeUndefined();
      } else {
        const unattended = new OAuthProvider(url, store, undefined, "registered-client");
        await expect(auth(unattended, { serverUrl: url })).rejects.toThrow("authentication_required");
        expect(browserOpens).toBe(0);
        await authenticate(url, open, AbortSignal.timeout(10_000), store, "registered-client");
        expect(authorizations).toBe(1);
        expect(JSON.parse(store.read()!).clients[base].client_id).toBe("registered-client");
        const resumed = new OAuthProvider(url, store, undefined, "registered-client");
        expect(await auth(resumed, { serverUrl: url })).toBe("AUTHORIZED");
        expect(refreshes).toBe(1);
        // Explicit login must open the browser even when a refresh token exists.
        await authenticate(url, open, AbortSignal.timeout(10_000), store, "registered-client");
        expect(browserOpens).toBe(2);
        expect(authorizations).toBe(2);
        expect(refreshes).toBe(1);
        expect(store.read()).not.toContain("private-code");
        expect(await logout(url, store, undefined, "registered-client")).toBe("confirmed");
        expect(revoked).toEqual(["private-refresh", "private-access"]);
        expect(store.read()).toBeNull();
      }
      expect(registrations).toBe(0);
    } finally { await server.stop(true); }
  }, 15_000);
}
