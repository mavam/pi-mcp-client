import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { serverMatrix, inspectTool, toolPickerLabel } from "../src/management.js";
import { prepareTool } from "../src/catalog.js";
import { diagnostic } from "../src/diagnostics.js";
import type { ServerStatus } from "../src/runtime.js";

test("picker labels stay within terminal bounds and on one line", () => {
  const tool = prepareTool("example", "identity", {
    name: "search", description: "Find records 界 ".repeat(40),
    inputSchema: { type: "object", properties: {} },
  });
  for (const columns of [20, 40, 80, 120]) {
    const label = toolPickerLabel(tool, 0, columns);
    expect(visibleWidth(label)).toBeLessThanOrEqual(columns - 4);
    expect(label).not.toContain("\n");
    expect(label).not.toContain("\u001b");
  }
});

test("tool details show parameter types, requirements, and descriptions", () => {
  const tool = prepareTool("example", "identity", {
    name: "search",
    description: "Find records",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match" },
        limit: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
        cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["query"],
      additionalProperties: false,
    },
  });
  const text = inspectTool(tool);
  expect(text).toContain("query: string (required)");
  expect(text).toContain("Text to match");
  expect(text).toContain("limit: integer (optional)");
  expect(text).toContain("tags: Array<string> (optional)");
  expect(text).toContain("cursor: string | null (optional)");
  expect(text).toContain("Find records");
});

const servers: ServerStatus[] = [
  { name: "linear", state: "disconnected" },
  { name: "cloudflare", state: "connected", catalogSize: 12 },
  { name: "pending", state: "connecting" },
  { name: "disabled", state: "disabled" },
  { name: "failed", state: "failed", error: diagnostic("authentication_required", { operation: "connect" }) },
  { name: "empty", state: "connected", catalogSize: 0 },
];

test("status matrix distinguishes idle, connected, loading, disabled, failed, and empty catalogs", () => {
  const text = serverMatrix(servers, new Map([["cloudflare", 3]]));
  expect(text).toMatch(/linear\s+idle/);
  expect(text).toMatch(/cloudflare\s+connected\s+12\s+3/);
  expect(text).toMatch(/pending\s+connecting/);
  expect(text).toMatch(/disabled\s+disabled/);
  expect(text).toMatch(/failed\s+error/);
  expect(text).toContain("[authentication_required]");
  expect(text).toMatch(/empty\s+connected\s+0\s+0/);
});

test("status matrix is sanitized and width bounded", () => {
  const long: ServerStatus[] = [{ name: "\u001b[31m" + "x".repeat(80), state: "disconnected" }];
  for (const width of [0, 1, 10, 40, 80]) {
    const text = serverMatrix(long, new Map(), width);
    expect(text).not.toContain("\u001b");
    for (const row of text.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  }
});
