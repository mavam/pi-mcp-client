import { expect, test } from "bun:test";
import { authenticate, type SecretStore } from "../src/auth.js";
import { diagnose } from "../src/diagnostics.js";

test("SDK login without dynamic registration reports a missing client before browser handoff", async () => {
  let base = "";
  let opened = false;
  let handedOff = false;
  let stored = false;
  const store: SecretStore = {
    read: () => null,
    remove: () => {},
    write: () => { stored = true; },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  try {
    let error: unknown;
    try {
      await authenticate({ server: "example", url: `${base}/mcp` }, async () => { opened = true; },
        AbortSignal.timeout(5_000), store, {
          handoff: async () => { handedOff = true; return undefined; },
        });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    const result = diagnose(error, { server: "slack", operation: "auth" });
    expect(result.code).toBe("oauth_client_required");
    expect(result.hint).toContain("oauthClientId");
    expect(result.hint).toContain("/mcp login slack");
    expect(opened).toBe(false);
    expect(handedOff).toBe(false);
    expect(stored).toBe(false);
  } finally {
    await server.stop(true);
  }
}, 10_000);
