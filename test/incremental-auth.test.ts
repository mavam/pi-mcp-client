import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { McpRuntime, createSdkConnector } from "../src/runtime.js";
import { authorizationOptions, parseScopes } from "../src/authorization.js";
import { authenticate } from "../src/auth.js";
import { diagnose } from "../src/diagnostics.js";
import { scopeServer } from "./helpers/scope-server.js";

for (const method of ["tools/call", "tools/list", "resources/read", "prompts/get"]) {
  test(`scope challenges stop ${method} without authentication or replay`, async () => {
    const fixture = scopeServer(method);
    const directory = await mkdtemp(join(tmpdir(), "mcp-scopes-"));
    const runtime = new McpRuntime({ example: fixture.config }, directory, directory, createSdkConnector(async () => fixture.store));
    try {
      const invoke = async () => {
        if (method === "tools/list") return runtime.catalog("example", undefined, true);
        if (method === "resources/read") return runtime.readResource("example", "test://resource");
        if (method === "prompts/get") return runtime.getPrompt("example", "write", {});
        return runtime.call((await runtime.catalog("example"))[0], {});
      };
      await expect(invoke()).rejects.toThrow("oauth_scope_required");
      expect(fixture.requests.filter(value => value === method)).toHaveLength(1);
      expect(fixture.requests).not.toContain("token");
      const challenge = runtime.authorizationChallenge("example")!;
      expect(challenge.scopes).toEqual(["write"]);
      const options = authorizationOptions(fixture.identity, fixture.store, { oauthScopes: ["base"] }, challenge.scopes);
      expect(options.oauthScopes?.sort()).toEqual(["base", "read", "write"]);
      await authenticate(fixture.identity, async () => { throw new Error("No browser"); }, undefined, fixture.store, {
        ...options, handoff: async (target) => {
          const auth = new URL(target);
          expect(auth.searchParams.get("scope")?.split(" ").sort()).toEqual(["base", "read", "write"]);
          const callback = new URL(auth.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", auth.searchParams.get("state")!);
          callback.searchParams.set("code", "approved");
          return callback.href;
        },
      });
      expect(fixture.requests.filter(value => value === method)).toHaveLength(1);
      runtime.clearAuthorizationChallenge("example", challenge);
      expect(runtime.authorizationChallenge("example")).toBeUndefined();
      await runtime.reconnect("example");
      await invoke();
    } finally { await runtime.close(); await fixture.stop(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("challenge scope validation is bounded and diagnostics never echo server data", () => {
  for (const value of [undefined, "", "read\nwrite", "bad\\scope", "bad\"scope", "é", "x".repeat(257), Array.from({ length: 101 }, (_, i) => `s${i}`).join(" ")])
    expect(parseScopes(value)).toBeUndefined();
  expect(parseScopes("read write read")).toEqual(["read", "write"]);
  const value = diagnose(new InsufficientScopeError({ requiredScope: "private-scope", errorDescription: "private-error", resourceMetadataUrl: new URL("https://private.example") }), { server: "example", operation: "call" });
  expect(value.code).toBe("oauth_scope_required");
  expect(JSON.stringify(value)).not.toContain("private");
});
