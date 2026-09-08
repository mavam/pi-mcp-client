import { expect, test } from "bun:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { prepareTool } from "../src/catalog.js";
import { Exposure, restoredTools } from "../src/exposure.js";

const tool = (name: string) =>
  prepareTool("fixture", "identity", {
    name,
    inputSchema: { type: "object", properties: {} },
  });
function host(excluded: string[] = []) {
  let active = ["read", "mcp_tools"];
  const registered = new Set(active);
  const api = {
    getActiveTools: () => [...active],
    getAllTools: () => [...registered].map((name) => ({ name })),
    setActiveTools: (names: string[]) => {
      active = [...new Set(names)].filter(
        (name) => registered.has(name) && !excluded.includes(name),
      );
    },
  } as unknown as ExtensionAPI;
  const exposure = new Exposure(api, (definition) => {
    registered.add(definition.nativeName);
    active.push(definition.nativeName);
  });
  return { exposure, api, registered };
}

test("search activation is additive and idempotent", () => {
  const { exposure, api } = host();
  const a = tool("a"),
    b = tool("b");
  expect(exposure.load([a]).added).toEqual([a.nativeName]);
  expect(exposure.load([b]).added).toEqual([b.nativeName]);
  expect(api.getActiveTools()).toEqual([
    "read",
    "mcp_tools",
    a.nativeName,
    b.nativeName,
  ]);
  expect(exposure.load([a]).added).toEqual([]);
});

test("does not override tools owned elsewhere or claim restricted tools", () => {
  const a = tool("a"),
    b = tool("b");
  const { exposure, registered } = host([b.nativeName]);
  registered.add(a.nativeName);
  const result = exposure.load([a, b]);
  expect(result.loaded).toEqual([]);
  expect(result.rejected).toEqual([a.nativeName, b.nativeName]);
});

test("branch restoration removes only owned tools", () => {
  const { exposure, api } = host();
  const a = tool("a"),
    b = tool("b");
  exposure.load([a, b]);
  exposure.restore([a]);
  expect(api.getActiveTools()).toEqual(["read", "mcp_tools", a.nativeName]);
  exposure.restore([]);
  expect(api.getActiveTools()).toEqual(["read", "mcp_tools"]);
});

test("restores definitions from successful loader results, not other branches", () => {
  const a = tool("a"),
    b = tool("b");
  const entry = (loaded: unknown[], isError = false) =>
    ({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "mcp_tools",
        isError,
        details: { mcpClient: 1, loaded },
      },
    }) as unknown as SessionEntry;
  expect(restoredTools([entry([a]), entry([b], true)])).toEqual([a]);
  expect(restoredTools([entry([{ invalid: true }])])).toEqual([]);
  const batch = Array.from({ length: 50 }, (_, i) => tool(`tool_${i}`));
  expect(restoredTools([entry(batch)])).toEqual(batch);
});
