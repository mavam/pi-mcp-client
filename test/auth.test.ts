import { expect, test } from "bun:test";
import { authenticate, type SecretStore } from "../src/auth.js";

test("SDK OAuth round trip validates callback state and stores tokens", async () => {
  let record: string | null = null;
  const store: SecretStore = {
    read: () => record,
    remove: () => { record = null; },
    write: (value) => {
      record = value;
    },
  };
  let base = "";
  let tokenRequests = 0;
  let sawVerifier = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ["read"],
        });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
      if (path === "/register")
        return Response.json(
          { ...((await request.json()) as object), client_id: "fixture-client" },
          { status: 201 },
        );
      if (path === "/token") {
        tokenRequests++;
        const body = new URLSearchParams(await request.text());
        sawVerifier = !!body.get("code_verifier");
        return Response.json({
          access_token: "fixture-access",
          token_type: "Bearer",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  try {
    await authenticate(
      `${base}/mcp`,
      async (target) => {
        const authorization = new URL(target);
        expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
        const callback = new URL(authorization.searchParams.get("redirect_uri")!);
        callback.searchParams.set("code", "fixture-code");
        callback.searchParams.set("state", "wrong-state");
        expect((await fetch(callback)).status).toBe(400);
        expect(tokenRequests).toBe(0);
        callback.searchParams.set("state", authorization.searchParams.get("state")!);
        expect((await fetch(callback)).status).toBe(200);
      },
      AbortSignal.timeout(10_000),
      store,
    );
    expect(tokenRequests).toBe(1);
    expect(sawVerifier).toBe(true);
    expect(JSON.parse(record!).tokens.access_token).toBe("fixture-access");
    expect(JSON.parse(record!).url).toBe(`${base}/mcp`);
    expect(record).not.toContain("fixture-code");
  } finally {
    await server.stop(true);
  }
}, 15_000);
