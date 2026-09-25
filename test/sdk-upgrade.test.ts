import { expect, test, spyOn } from "bun:test";
import { auth } from "@modelcontextprotocol/client";
import { OAuthProvider, type SecretStore } from "../src/auth.js";
import { failure } from "../src/diagnostics.js";
import { privateOAuthFetch } from "../src/oauth-fetch.js";

for (const scenario of ["store-failure", "invalid-grant", "malformed-error", "success-error", "bom", "incidental-error"] as const) {
  test(`SDK refresh regression: ${scenario}`, async () => {
    let base = "";
    let refreshes = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
      if (path === "/token") {
        refreshes++;
        if (scenario === "malformed-error") return new Response("private-payload", { status: 500 });
        if (["invalid-grant", "success-error"].includes(scenario)) return Response.json({ error: "invalid_grant", error_description: "private-payload" }, {
          status: scenario === "success-error" ? 200 : 400,
        });
        const tokens = { access_token: "private-new-token", refresh_token: "private-rotated", token_type: "Bearer" };
        return scenario === "bom" ? new Response(`\uFEFF${JSON.stringify(tokens)}`)
          : Response.json({ ...tokens, ...(scenario === "incidental-error" ? { error: null } : {}) });
      }
      return new Response(null, { status: 404 });
    } });
    base = `http://127.0.0.1:${server.port}`;
    let record: string | null = null;
    let locked = false;
    const store: SecretStore = { read: () => record, remove: () => { record = null; }, write: (value) => {
      if (locked) throw failure("credential_store_unavailable", { operation: "auth" });
      record = value;
    } };
    const provider = new OAuthProvider({ server: "example", url: `${base}/mcp`, clientId: "client" }, store);
    provider.saveTokens({ access_token: "private-old", refresh_token: "private-refresh", token_type: "Bearer", issuer: base });
    locked = scenario === "store-failure";
    const warnings: unknown[][] = [];
    const warn = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); });
    try {
      const success = ["bom", "incidental-error"].includes(scenario);
      const result = auth(provider, { serverUrl: `${base}/mcp`, fetchFn: privateOAuthFetch });
      if (success) {
        expect(await result).toBe("AUTHORIZED");
        expect(provider.tokens()?.refresh_token).toBe("private-rotated");
      } else await expect(result).rejects.toThrow(
        scenario === "store-failure" ? "credential_store_unavailable" : "authentication_required",
      );
      expect(refreshes).toBe(1);
      expect(JSON.stringify(warnings)).not.toContain("private-");
      if (scenario === "store-failure" || success) expect(warnings).toEqual([]);
      else expect(warnings.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
      await server.stop(true);
    }
  });
}
