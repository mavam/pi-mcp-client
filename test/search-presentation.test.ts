import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "../src/catalog.js";

test("one flat tool schema supports mixed discovery, activation, and resource reading", () => {
  const tools: any[] = [];
  extension({
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  expect(tool.name).toBe("mcp_tools");
  const schema = tool.parameters;
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
  expect(schema).not.toHaveProperty("anyOf");
  expect(schema).not.toHaveProperty("oneOf");
  expect(schema.required ?? []).not.toContain("query");
  expect(schema.required ?? []).not.toContain("activate");
  expect(schema.properties.limit.minimum).toBe(1);
  expect(schema.properties.limit.maximum).toBe(MAX_SEARCH_LIMIT);
  expect(schema.properties.limit.default).toBe(DEFAULT_SEARCH_LIMIT);
  expect(schema.properties.activate.minItems).toBe(1);
  expect(schema.properties.activate.maxItems).toBe(MAX_SEARCH_LIMIT);
  expect(schema.required ?? []).not.toContain("read");
  expect(schema.properties.kind.enum).toEqual(["all", "tools", "resources", "prompts"]);
  expect(schema.properties.read.required).toEqual(["server"]);
  expect(schema.properties.read.properties.template.maxLength).toBe(4096);
  expect(schema.properties.read.properties.arguments.maxProperties).toBe(100);
  expect(schema.properties.read.additionalProperties).toBe(false);
  expect(schema.properties.read.properties.uri.maxLength).toBe(4096);
});
