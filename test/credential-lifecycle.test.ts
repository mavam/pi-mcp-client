import { expect, test } from "bun:test";
import { logout, OAuthProvider, type SecretStore } from "../src/auth.js";
import { authenticationSummary } from "../src/management.js";

function memoryStore(): SecretStore {
  let record: string | null = null;
  return {
    read: () => record,
    write: (value) => { record = value; },
    remove: () => { record = null; },
  };
}

for (const outcome of ["confirmed", "unsupported", "failure", "issuer-change", "insecure", "redirect", "cancelled"] as const) {
  test(`logout removes credentials before network work (${outcome})`, async () => {
    const store = memoryStore();
    let base = "";
    const received: URLSearchParams[] = [];
    let redirects = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        expect(store.read()).toBeNull();
        const path = new URL(request.url).pathname;
        if (path.startsWith("/.well-known/oauth-protected-resource"))
          return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
        if (path === "/.well-known/oauth-authorization-server")
          return Response.json({
            issuer: base,
            authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
            response_types_supported: ["code"],
            ...(outcome === "unsupported" ? {} : {
              revocation_endpoint: outcome === "insecure" ? "http://example.com/revoke" : `${base}/revoke`,
            }),
          });
        if (path === "/revoke") {
          received.push(new URLSearchParams(await request.text()));
          if (outcome === "redirect") return Response.redirect(`${base}/redirect`, 307);
          return new Response(outcome === "failure" ? "private-server-error" : "", { status: outcome === "failure" ? 500 : 200 });
        }
        if (path === "/redirect") redirects++;
        return new Response("Not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    const url = `${base}/mcp`;
    const issuer = outcome === "issuer-change" ? "https://old.example" : base;
    const old = new OAuthProvider(url, store);
    old.saveClientInformation({ client_id: "fixture-client", issuer }, { issuer });
    old.saveTokens({ access_token: "private-access", refresh_token: "private-refresh", token_type: "Bearer", issuer });
    try {
      const result = await logout(url, store, outcome === "cancelled" ? AbortSignal.abort() : undefined);
      expect(result).toBe(outcome === "confirmed" || outcome === "unsupported" ? outcome : "unconfirmed");
      expect(store.read()).toBeNull();
      expect(() => old.tokens()).toThrow("authentication_required");
      expect(() => old.saveTokens({ access_token: "late-refresh", token_type: "Bearer" })).toThrow("authentication_required");
      expect(new OAuthProvider(url, store).tokens()).toBeUndefined();
      if (outcome === "confirmed") {
        expect(received.map((body) => body.get("token"))).toEqual(["private-refresh", "private-access"]);
        expect(received.map((body) => body.get("token_type_hint"))).toEqual(["refresh_token", "access_token"]);
        expect(received.every((body) => body.get("client_id") === "fixture-client")).toBe(true);
      }
      if (["unsupported", "issuer-change", "insecure", "cancelled"].includes(outcome)) expect(received).toHaveLength(0);
      expect(redirects).toBe(0);
    } finally { await server.stop(true); }
  });
}

test("empty and corrupt records can be removed, but removal failures stay failures", async () => {
  const store = memoryStore();
  const url = "https://empty.example/mcp";
  const pending = new OAuthProvider(url, store);
  expect(await logout(url, store)).toBe("not-needed");
  expect(() => pending.saveTokens({ access_token: "late-login", token_type: "Bearer" })).toThrow("authentication_required");
  expect(await logout(url, store)).toBe("not-needed");
  store.write("invalid-private-record");
  expect(await logout(url, store)).toBe("unconfirmed");
  expect(store.read()).toBeNull();
  await expect(logout(url, { ...store, remove: () => { throw new Error("denied"); } })).rejects.toThrow("denied");
});

test("providers cannot reuse or overwrite a credential record changed outside the process", () => {
  const store = memoryStore();
  const provider = new OAuthProvider("https://external.example/mcp", store);
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer" });
  store.remove();
  expect(() => provider.tokens()).toThrow("authentication_required");
  expect(() => provider.invalidateCredentials("all")).toThrow("authentication_required");
  expect(store.read()).toBeNull();
});

test("authentication inspection is local, redacted, and distinguishes unavailable from absent", async () => {
  const store = memoryStore();
  const url = "https://status.example/mcp";
  let reads = 0;
  const factory = async (resolved: string) => { expect(resolved).toBe(url); reads++; return store; };
  expect(await authenticationSummary({ url }, "/", factory)).toContain("no stored tokens");
  const provider = new OAuthProvider(url, store);
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer" });
  expect(await authenticationSummary({ url, headers: { "X-Key": "!never-execute" } }, "/", factory))
    .toBe("OAuth · stored tokens (validity not checked)");
  store.write("private-malformed-record");
  expect(await authenticationSummary({ url }, "/", factory)).toBe("OAuth · credential status unavailable");
  expect(await authenticationSummary({ url }, "/", async () => { throw new Error("private-store-error"); }))
    .toBe("OAuth · credential status unavailable");
  expect(await authenticationSummary({ url, headers: { Authorization: "!never-execute" } }, "/", factory)).toContain("externally managed");
  expect(await authenticationSummary({ command: "never-execute" }, "/", factory)).toContain("Server-managed");
  expect(await authenticationSummary({ url }, "/", factory)).toBe("OAuth · credential status unavailable");
  expect(reads).toBe(4);
});
