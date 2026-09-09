import { expect, test } from "bun:test";
import { auth } from "@modelcontextprotocol/client";
import {
  authenticate, connectionAuthProvider, credentialKey, logout, OAuthProvider,
  type CredentialStoreFactory, type OAuthIdentity, type SecretStore,
} from "../src/auth.js";
import { authenticationSummary } from "../src/management.js";

function memoryStore(): SecretStore {
  let record: string | null = null;
  return { read: () => record, write: (value) => { record = value; }, remove: () => { record = null; } };
}

test("named credentials reject renamed and legacy records and isolate invalidation epochs", async () => {
  const personal = { server: "personal", url: "https://example.com/mcp", clientId: "client" };
  const work = { ...personal, server: "work" };
  expect(credentialKey(personal)).not.toBe(credentialKey(work));
  const store = memoryStore();
  const provider = new OAuthProvider(personal, store);
  provider.saveTokens({ access_token: "personal-token", token_type: "Bearer", issuer: "https://issuer.example" });
  expect(() => new OAuthProvider(work, store)).toThrow("Invalid OAuth credential record");
  const legacy = JSON.parse(store.read()!);
  delete legacy.server;
  store.write(JSON.stringify(legacy));
  expect(() => new OAuthProvider(personal, store)).toThrow("Invalid OAuth credential record");

  const personalStore = memoryStore(), workStore = memoryStore();
  const pendingPersonal = new OAuthProvider(personal, personalStore);
  const pendingWork = new OAuthProvider(work, workStore);
  await logout(personal, personalStore);
  expect(() => pendingPersonal.saveTokens({ access_token: "late", token_type: "Bearer", issuer: "https://issuer.example" })).toThrow("authentication_required");
  pendingWork.saveTokens({ access_token: "work-token", token_type: "Bearer", issuer: "https://issuer.example" });
  expect(pendingWork.tokens()?.access_token).toBe("work-token");
  pendingWork.invalidateCredentials("tokens");
  expect(pendingWork.tokens()).toBeUndefined();
});

for (const clientId of [undefined, "registered-client"]) {
  test(`same-endpoint named logins isolate registration, refresh, status, and logout (client=${clientId})`, async () => {
    let base = "";
    let registrations = 0;
    const refreshed: string[] = [], revoked: string[] = [];
    const stores = new Map<string, SecretStore>();
    const factory: CredentialStoreFactory = async (identity) => {
      const key = credentialKey(identity);
      if (!stores.has(key)) stores.set(key, memoryStore());
      return stores.get(key)!;
    };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`, revocation_endpoint: `${base}/revoke`,
          response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      if (path === "/register") return Response.json({
        ...await request.json() as object, client_id: `dynamic-${++registrations}`,
      }, { status: 201 });
      if (path === "/token") {
        const params = new URLSearchParams(await request.text());
        const refresh = params.get("grant_type") === "refresh_token";
        const account = refresh ? params.get("refresh_token")!.replace("-refresh", "") : params.get("code")!;
        if (refresh) refreshed.push(account);
        return Response.json({ access_token: `${account}-${refresh ? "renewed" : "access"}`,
          refresh_token: `${account}-refresh`, token_type: "Bearer" });
      }
      if (path === "/revoke") {
        revoked.push(new URLSearchParams(await request.text()).get("token")!);
        return new Response("");
      }
      return new Response("Not found", { status: 404 });
    } });
    base = `http://127.0.0.1:${server.port}`;
    const url = `${base}/mcp`;
    const identities: OAuthIdentity[] = ["personal", "work"].map(server => ({ server, url, clientId }));
    try {
      for (const identity of identities) {
        await authenticate(identity, async () => { throw new Error("must use handoff"); },
          AbortSignal.timeout(5_000), await factory(identity), {
            handoff: async (target) => {
              const authorization = new URL(target);
              const callback = new URL(authorization.searchParams.get("redirect_uri")!);
              callback.searchParams.set("state", authorization.searchParams.get("state")!);
              callback.searchParams.set("code", identity.server);
              return callback.href;
            },
          });
      }
      expect(registrations).toBe(clientId ? 0 : 2);
      const [personal, work] = identities;
      const workStore = await factory(work);
      const snapshot = workStore.read();
      const definition = { url, oauthClientId: clientId };
      const background = await connectionAuthProvider(personal.server, definition, factory);
      expect(await auth(background!, { serverUrl: url })).toBe("AUTHORIZED");
      expect(refreshed).toEqual(["personal"]);
      expect(workStore.read()).toBe(snapshot);
      expect(new OAuthProvider(personal, await factory(personal)).tokens()?.access_token).toBe("personal-renewed");
      expect(new OAuthProvider(work, workStore).tokens()?.access_token).toBe("work-access");
      // Matching definitions across projects use the same named credential identity.
      expect(await authenticationSummary("work", definition, "/project-a", factory)).toContain("stored tokens");
      expect(await authenticationSummary("work", definition, "/project-b", factory)).toContain("stored tokens");
      expect(await authenticationSummary("renamed", definition, "/project-b", factory)).toContain("no stored tokens");
      const pendingWork = new OAuthProvider(work, workStore);
      expect(await logout(personal, await factory(personal))).toBe("confirmed");
      expect(revoked).toEqual(["personal-refresh", "personal-renewed"]);
      expect(await authenticationSummary("personal", definition, "/", factory)).toContain("no stored tokens");
      expect(pendingWork.tokens()?.access_token).toBe("work-access");
      expect(await auth(pendingWork, { serverUrl: url })).toBe("AUTHORIZED");
      expect(refreshed).toEqual(["personal", "work"]);
    } finally { await server.stop(true); }
  }, 15_000);
}
