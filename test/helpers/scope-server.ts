import { OAuthProvider, type SecretStore } from "../../src/auth.js";

export function scopeServer(method = "tools/call", scope = "write") {
  let base = "";
  let record: string | null = null;
  let upgraded = false;
  const requests: string[] = [];
  const store: SecretStore = { read: () => record, write: value => { record = value; }, remove: () => { record = null; } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (path === "/.well-known/oauth-authorization-server")
      return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        response_types_supported: ["code"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
    if (path === "/token") {
      requests.push("token");
      const params = new URLSearchParams(await request.text());
      if (params.get("grant_type") !== "authorization_code") throw new Error("Unexpected refresh");
      upgraded = true;
      return Response.json({ access_token: "upgraded", token_type: "Bearer", scope: "read write" });
    }
    if (path !== "/mcp") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const message = await request.json() as any;
    requests.push(message.method);
    if (!upgraded && message.method === method) return new Response("private-error", { status: 403, headers: {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}", error_description="private-description"`,
    } });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const results: Record<string, unknown> = {
      initialize: { protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } },
      "tools/list": { tools: [{ name: "write", inputSchema: { type: "object" } }] },
      "tools/call": { content: [{ type: "text", text: "done" }] },
      "resources/read": { contents: [{ uri: "test://resource", text: "done" }] },
      "prompts/list": { prompts: [{ name: "write" }] },
      "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "done" } }] },
      "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] },
    };
    return Response.json({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} });
  } });
  base = `http://127.0.0.1:${server.port}`;
  const identity = { server: "example", url: `${base}/mcp`, clientId: "client" };
  new OAuthProvider(identity, store).saveTokens({ access_token: "old", token_type: "Bearer", scope: "read", issuer: base });
  return { identity, store, requests, config: { url: identity.url, oauthClientId: "client", protocol: "legacy" as const },
    stop: () => server.stop(true) };
}
