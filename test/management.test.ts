import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { serverMatrix, inspectTool, toolPickerLabel } from "../src/management.js";
import { prepareTool } from "../src/catalog.js";
import { diagnostic } from "../src/diagnostics.js";
import type { ServerStatus } from "../src/runtime.js";

test("picker descriptions use terminal columns, an ellipsis, and no wrapping", () => {
  const tool = prepareTool("example", "identity", {
    name: "search", description: "Find records 界 ".repeat(40),
    inputSchema: { type: "object", properties: {} },
  });
  for (const columns of [20, 40, 80, 120]) {
    const label = toolPickerLabel(tool, 0, columns);
    expect(visibleWidth(label)).toBeLessThanOrEqual(columns - 4);
    expect(label).toStartWith("1. search: ");
    expect(label).toEndWith("…");
    expect(label).not.toContain("\n");
    expect(label).not.toContain("\u001b");
  }
  expect(toolPickerLabel({ ...tool, description: "Short." }, 0, 80)).toBe("1. search: Short.");
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
  expect(text).toContain("query: string (required)\nText to match\n\nlimit:");
  expect(text).toStartWith("search(\n  query: string,\n  limit?: integer,\n  tags?: Array<string>,\n  cursor?: string | null,\n)\n\nFind records\n\nParameters:");
  expect(text).toContain("limit: integer (optional)");
  expect(text).toContain("tags: Array<string> (optional)");
  expect(text).toContain("cursor: string | null (optional)");
  expect(text).toContain("Find records");
});

test("large tool details keep arguments on separate lines and descriptions as full paragraphs", () => {
  const description = "Long parameter description. ".repeat(20).trim();
  const properties = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [
    `arg${i}`, { type: "string", description },
  ]));
  const tool = prepareTool("linear", "identity", {
    name: "save_project", description: "Create or update.\nMore information.",
    inputSchema: { type: "object", properties, additionalProperties: false },
  });
  const text = inspectTool(tool);
  const [signature, paragraph] = text.split("\n\n");
  expect(signature.split("\n")).toHaveLength(25);
  expect(signature).toContain("  arg22?: string,\n)");
  expect(paragraph).toBe("Create or update. More information.");
  expect(text).toContain(`arg0: string (optional)\n${description}\n\narg1:`);
  expect(text).not.toContain("… +");
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
  expect(text).toContain("○ linear");
  expect(text).toMatch(/● cloudflare\s+connected\s+12\s+3/);
  expect(text).toContain("▶︎ pending");
  expect(text).toMatch(/○ disabled\s+disabled/);
  expect(text).toContain("✘︎ failed");
  expect(text).toContain("[authentication_required]");
  expect(text).toMatch(/● empty\s+connected\s+0\s+0/);
  expect(text).not.toContain("mcp_search");
});

test("status matrix is sanitized and width bounded", () => {
  const long: ServerStatus[] = [{ name: "\u001b[31m" + "x".repeat(80), state: "disconnected" }];
  for (const width of [0, 1, 10, 40, 80]) {
    const text = serverMatrix(long, new Map(), width);
    expect(text).not.toContain("\u001b");
    for (const row of text.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  }
  expect(serverMatrix([], new Map())).toBe("No MCP servers configured.");
});
