import { expect, test } from "bun:test";
import { authenticate, callbackUrl, OAuthProvider, parseCallback, type SecretStore } from "../src/auth.js";
import { parseConfig } from "../src/config.js";
import { parseConfigCommand, configCommandCompletions } from "../src/config-commands.js";
import { inspectServer } from "../src/management.js";
import { oauthCallbackHtml } from "../src/oauth-page.js";

function memoryStore(): SecretStore {
  let record: string | null = null;
  return { read: () => record, write: (value) => { record = value; }, remove: () => { record = null; } };
}

const definition = { url: "https://example.com/mcp" };
test("OAuth scopes and callback ports validate strictly and require HTTP OAuth", () => {
  for (const oauthScopes of [[], ["read", "read"], ["read write"], [""], ["quote\""], ["back\\slash"], ["é"], ["newline\n"], [4], "read", ["x".repeat(257)]])
    expect(() => parseConfig({ mcpServers: { test: { ...definition, oauthScopes } } })).toThrow();
  for (const oauthCallbackPort of [0, -1, 65536, 1.5, "19847", null])
    expect(() => parseConfig({ mcpServers: { test: { ...definition, oauthCallbackPort } } })).toThrow();
  for (const option of [{ oauthScopes: ["read"] }, { oauthCallbackPort: 19848 }]) {
    expect(parseConfig({ mcpServers: { test: { url: definition.url, ...option } } }).test).toEqual({ url: definition.url, ...option });
    for (const transport of [{ command: "server" }])
      expect(() => parseConfig({ mcpServers: { test: { ...transport, ...option } } })).toThrow();
  }
  const config = parseConfig({ mcpServers: { test: { ...definition, oauthScopes: ["read", "api:write"], oauthCallbackPort: 19848 } } }).test;
  const summary = inspectServer("test", config, "idle");
  expect(summary).toContain("Requested scopes: read, api:write");
  expect(summary).toContain("http://127.0.0.1:19848/callback");
  expect(summary).not.toContain(definition.url);
  expect(callbackUrl()).toBe("http://127.0.0.1:19847/callback");
});

test("add accepts repeatable scopes and a single numeric callback port", () => {
  const command = parseConfigCommand("add --scope global --oauth-scope read --oauth-scope write --oauth-callback-port 19848 service https://example.com/mcp");
  expect(command?.action === "add" && command.definition).toEqual({ ...definition, oauthScopes: ["read", "write"], oauthCallbackPort: 19848 });
  for (const port of ["0", "65536", "1.5", "1e3", "0x1234"])
    expect(() => parseConfigCommand(`add --scope global --oauth-callback-port ${port} service https://example.com`)).toThrow();
  expect(() => parseConfigCommand("add --scope global --oauth-callback-port 12 --oauth-callback-port 13 service https://example.com")).toThrow();
  expect(configCommandCompletions("add --scope global --oauth-", [])?.map((item) => item.label)).toContain("--oauth-scope");
});

test("callback handoff requires exact origin, path, state, and an unambiguous response", () => {
  const redirect = callbackUrl();
  const valid = `${redirect}?code=private-code&state=expected`;
  expect(parseCallback(valid, redirect, "expected").get("code")).toBe("private-code");
  expect(parseCallback(`${redirect}?error=access_denied&state=expected`, redirect, "expected").get("error")).toBe("access_denied");
  for (const value of [
    "private-code", "/callback?code=private-code&state=expected", valid.replace("127.0.0.1", "localhost"),
    valid.replace("19847", "19848"), valid.replace("http:", "https:"), valid.replace("/callback", "/other"),
    valid.replace("127.0.0.1", "user@127.0.0.1"), valid.replace("expected", "wrong"),
    `${valid}#fragment`, `${valid}&state=expected`, `${valid}&code=other`, `${valid}&error=denied`,
    `${redirect}?state=expected`, `${redirect}?code=&state=expected`, `${valid}\n`, `${valid}&x=${"x".repeat(17000)}`,
  ]) {
    try { parseCallback(value, redirect, "expected"); throw new Error("accepted callback"); }
    catch (error) {
      expect(String(error)).toContain("oauth_failed");
      expect(String(error)).not.toContain("private-code");
    }
  }
});

test("callback pages retain Pi branding without external assets or reflected data", () => {
  for (const status of ["received", "denied", "invalid"] as const) {
    const html = oauthCallbackHtml(status);
    expect(html).toContain("<svg");
    expect(html).toContain("Pi MCP Client</p>");
    expect(html).not.toMatch(/<script|<link|<img|src=/u);
    expect(html).not.toContain("Authentication successful");
  }
});

test("dynamic registrations renew for changed options without splitting credential identity", () => {
  const store = memoryStore();
  const issuer = "https://issuer.example";
  const first = new OAuthProvider(definition.url, store, undefined, undefined);
  first.saveClientInformation({ client_id: "dynamic", issuer }, { issuer });
  first.saveTokens({ access_token: "private-token", token_type: "Bearer", issuer });
  const options = { oauthScopes: ["read"], oauthCallbackPort: 19848 };
  const changed = new OAuthProvider(definition.url, store, () => {}, undefined, options);
  expect(changed.clientInformation({ issuer })).toBeUndefined();
  expect(changed.tokens()?.access_token).toBe("private-token");
  expect(new OAuthProvider(definition.url, store, undefined, undefined, options).clientInformation({ issuer })?.client_id).toBe("dynamic");
  changed.saveClientInformation({ client_id: "new-dynamic", issuer }, { issuer });
  expect(changed.tokens()).toBeUndefined();
  expect(changed.clientInformation({ issuer })?.client_id).toBe("new-dynamic");
  expect(new OAuthProvider(definition.url, store, () => {}, undefined, options).clientInformation({ issuer })?.client_id).toBe("new-dynamic");
  const publicStore = memoryStore();
  new OAuthProvider(definition.url, publicStore, undefined, "public").saveTokens({ access_token: "private-token", token_type: "Bearer", issuer });
  const publicClient = new OAuthProvider(definition.url, publicStore, () => {}, "public", options);
  expect(() => publicClient.clientInformation({ issuer: "https://replacement.example" })).toThrow("oauth_issuer_changed");
});

test("occupied custom callback ports fail safely without launching a browser", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  let opened = false;
  try {
    await expect(authenticate(definition.url, async () => { opened = true; }, undefined, memoryStore(), undefined,
      { oauthCallbackPort: occupied.port })).rejects.toThrow("callback_unavailable");
    expect(opened).toBe(false);
  } finally { await occupied.stop(true); }
});

for (const mode of ["browser", "manual", "cancel", "abort", "denied", "wrong-state", "wrong-issuer"] as const) {
  test(`SDK OAuth options round trip (${mode})`, async () => {
    const store = memoryStore();
    let base = "";
    let tokenRequests = 0;
    const callbackPort = 19849;
    const controller = new AbortController();
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["server-default"] });
        if (path === "/.well-known/oauth-authorization-server")
          return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
            registration_endpoint: `${base}/register`, response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true });
        if (path === "/register") {
          const metadata = await request.json() as Record<string, unknown>;
          expect(metadata.scope).toBe("read write");
          expect(metadata.redirect_uris).toEqual([callbackUrl({ oauthCallbackPort: callbackPort })]);
          return Response.json({ ...metadata, client_id: "fixture-client" }, { status: 201 });
        }
        if (path === "/token") {
          tokenRequests++;
          const body = new URLSearchParams(await request.text());
          expect(body.get("redirect_uri")).toBe(callbackUrl({ oauthCallbackPort: callbackPort }));
          expect(body.get("code_verifier")).toBeTruthy();
          expect(body.get("code")).toBe("private-code");
          return Response.json({ access_token: "private-token", token_type: "Bearer" });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    // Manual mode must not need a free local port.
    const occupied = mode === "browser" ? undefined : Bun.serve({ hostname: "127.0.0.1", port: callbackPort, fetch: () => new Response("occupied") });
    const response = (target: string) => {
      const authorization = new URL(target);
      expect(authorization.searchParams.get("scope")).toBe("read write");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set(mode === "denied" ? "error" : "code", mode === "denied" ? "access_denied" : "private-code");
      callback.searchParams.set("state", mode === "wrong-state" ? "wrong" : authorization.searchParams.get("state")!);
      callback.searchParams.set("iss", mode === "wrong-issuer" ? "https://wrong.example" : base);
      return callback;
    };
    try {
      const login = authenticate(`${base}/mcp`, async (target) => {
        expect(mode).toBe("browser");
        const callback = response(target);
        const result = await fetch(callback);
        expect(result.status).toBe(200);
        expect(result.headers.get("content-type")).toContain("text/html");
        expect(result.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(result.headers.get("referrer-policy")).toBe("no-referrer");
        expect(result.headers.get("cache-control")).toBe("no-store");
        const html = await result.text();
        expect(html).toContain("Authorization response received");
        expect(html).not.toContain("private-code");
        expect((await fetch(callback)).status).toBe(400);
      }, controller.signal, store, undefined, {
        oauthScopes: ["read", "write"], oauthCallbackPort: callbackPort,
        ...(mode !== "browser" ? { handoff: async (target: string, signal: AbortSignal) => {
          expect(signal.aborted).toBe(false);
          if (mode === "cancel") return undefined;
          if (mode === "abort") { controller.abort(); return new Promise<string>(() => {}); }
          return response(target).href;
        } } : {}),
      });
      if (mode === "browser" || mode === "manual") {
        await login;
        expect(tokenRequests).toBe(1);
        expect(store.read()).toContain("private-token");
      } else {
        await expect(login).rejects.toThrow(mode === "cancel" || mode === "abort" ? "cancelled" : "oauth_failed");
        expect(tokenRequests).toBe(0);
        expect(store.read()).not.toContain("private-token");
      }
      expect(store.read()).not.toContain("private-code");
      expect(store.read()).not.toContain("code_verifier");
    } finally {
      occupied?.stop(true);
      await server.stop(true);
    }
  });
}
