import { expect, test } from "bun:test";
import type { RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { prepareTool } from "../src/catalog.js";
import { withRegisteredServers } from "../src/registered.js";

const server = (name: string, config: object): RegisteredMcpServer =>
  ({ name, extensionPath: "ext", config }) as RegisteredMcpServer;

test("registered servers translate Pi's configuration shape", () => {
  const { config, names, problems } = withRegisteredServers({}, [
    server("stdio", { command: "node", args: ["a"], enabled: false, timeout: 5 }),
    server("http", {
      url: "https://example.com/mcp",
      oauth: { clientId: "id", scope: "read write", callbackPort: 8765 },
      toolExposure: { "delete_*": "hidden" },
    }),
    server("locked", { command: "node", exposure: "hidden", toolExposure: { search: "direct" } }),
    server("off", { command: "node", exposure: "hidden" }),
  ], "/tmp");
  expect(problems).toEqual([]);
  expect([...names]).toEqual(["stdio", "http", "locked", "off"]);
  expect(config.stdio).toMatchObject({ command: "node", disabled: true, timeoutMs: 5000 });
  expect(config.http).toMatchObject({
    oauthClientId: "id", oauthScopes: ["read", "write"], oauthCallbackPort: 8765, excludeTools: ["delete_*"],
  });
  expect(config.locked?.includeTools).toEqual(["search"]);
  expect(config.off?.disabled).toBe(true);
});

test("mcp.json wins and invalid registrations are reported without secrets", () => {
  const configured = { same: { command: "configured" } };
  const { config, problems } = withRegisteredServers(configured, [
    server("same", { command: "registered" }),
    server("secret", { url: "https://example.com/mcp", oauth: { clientSecret: "hunter2" } }),
    server("broken", { command: "node", args: "nope" }),
  ], "/tmp");
  expect(config.same?.command).toBe("configured");
  expect(Object.keys(config)).toEqual(["same"]);
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).not.toContain("hunter2");
});

test("tool annotations keep only boolean hints", () => {
  const tool = prepareTool("s", "id", {
    name: "t",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: "yes", title: "x", openWorldHint: false },
  });
  expect(tool.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
  expect(prepareTool("s", "id", { name: "t", inputSchema: { type: "object" } }).annotations).toBeUndefined();
});
