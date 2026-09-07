import { describe, expect, test } from "bun:test";
import { allowed, interpolate, parseConfig, resolveServer } from "../src/config.js";
import { nativeName, plain, prepareTool, searchTools } from "../src/catalog.js";

const schema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};
const tool = (server: string, name: string, description = "") =>
  prepareTool(server, "identity", { name, description, inputSchema: schema });

describe("configuration", () => {
  test("validates supported fields and transport exclusivity", () => {
    expect(
      parseConfig({ mcpServers: { local: { command: "bun", args: ["server.ts"] } } })
        .local.command,
    ).toBe("bun");
    for (const entry of [
      { command: "bun", url: "https://example.com" },
      { command: "bun", oauth: true },
      { url: "https://example.com", env: {} },
      { command: "bun", timeoutMs: 0 },
      { command: "bun", unknown: true },
    ])
      expect(() => parseConfig({ mcpServers: { local: entry } })).toThrow();
  });
  test("does not execute shell syntax in configuration", () => {
    expect(interpolate("!cat ~/.secret", {})).toBe("!cat ~/.secret");
    expect(interpolate("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
    expect(() => interpolate("${MISSING}", {})).toThrow("Missing environment variable");
  });
  test("rejects unsafe URLs and conflicting auth", () => {
    for (const url of [
      "file:///tmp/a",
      "https://user:password@example.com/mcp",
      "https://example.com/mcp#fragment",
    ])
      expect(() => resolveServer({ url }, "/tmp")).toThrow();
    expect(() =>
      resolveServer(
        {
          url: "https://example.com",
          oauth: true,
          headers: { Authorization: "secret" },
        },
        "/tmp",
      ),
    ).toThrow();
    expect(resolveServer({ command: "bun", cwd: "relative" }, "/tmp").cwd).toBe(
      "/tmp/relative",
    );
  });
  test("include and exclude filters fail closed", () => {
    expect(
      allowed("get_issue", { includeTools: ["get_*"], excludeTools: ["*_secret"] }),
    ).toBe(true);
    expect(
      allowed("get_secret", { includeTools: ["get_*"], excludeTools: ["*_secret"] }),
    ).toBe(false);
    expect(allowed("get_issue", { includeTools: [] })).toBe(false);
    expect(allowed("get_issue", { disabled: true })).toBe(false);
  });
});

describe("tool catalog", () => {
  test("stable portable names without normalization collisions", () => {
    expect(nativeName("linear", "get_issue")).toBe("mcp__linear__get_issue");
    expect(nativeName("a__b", "c")).not.toBe(nativeName("a", "b__c"));
    expect(nativeName("a", "get.issue")).not.toBe(nativeName("a", "get_issue"));
    expect(nativeName("a".repeat(80), "b".repeat(300))).toHaveLength(64);
  });
  test("exact selector loads only that tool", () => {
    const tools = [tool("linear", "get_issue"), tool("linear", "list_issues")];
    expect(searchTools(tools, "linear.get_issue")).toEqual([tools[0]]);
    expect(searchTools(tools, "mcp__linear__get_issue")).toEqual([tools[0]]);
  });
  test("ranks capability names and supports server scoping", () => {
    const tools = [
      tool("linear", "list_issues", "Search issues by text"),
      tool("cloudflare", "search", "Search account settings"),
      tool("linear", "upload", "Upload a file"),
    ];
    expect(searchTools(tools, "search issues")[0].name).toBe("list_issues");
    expect(searchTools(tools, "search", "linear")).toHaveLength(1);
    expect(searchTools(tools, "nonexistent")).toEqual([]);
    expect(searchTools(tools, "search", undefined, 1)).toHaveLength(1);
  });
  test("BM25 favors focused names and descriptions over verbose incidental matches", () => {
    const tools = [
      tool("linear", "list_teams", "List teams in the workspace"),
      tool("linear", "save_comment", "Create comments. " + "Projects issues labels users comments updates. ".repeat(40) + "List teams."),
      tool("linear", "workspace", "List teams in the workspace"),
    ];
    expect(searchTools(tools, "list teams")[0]).toBe(tools[0]);
    expect(searchTools(tools, "teams").indexOf(tools[2])).toBeLessThan(
      searchTools(tools, "teams").indexOf(tools[1]),
    );
  });
  test("supports prefixes, camelCase, stop words, and deterministic ties", () => {
    const tools = [tool("b", "listTeams"), tool("a", "list_teams")];
    expect(searchTools(tools, "the list tea").map((x) => x.server)).toEqual(["a", "b"]);
    expect(searchTools([...tools].reverse(), "list tea")).toEqual(searchTools(tools, "list tea"));
    expect(searchTools(tools, "the MCP tools")).toEqual([]);
    expect(searchTools([], "teams")).toEqual([]);
    expect(searchTools(tools, "a.list_teams", "b")).not.toContain(tools[1]);
    expect(searchTools(tools, "A.LIST_TEAMS", undefined, 50)).toEqual([tools[1]]);
  });
  test("defaults to five, permits fifty, and uses the current catalog snapshot", () => {
    const tools = Array.from({ length: 60 }, (_, i) => tool("fixture", `search_${i}`, "Search records"));
    expect(searchTools(tools, "search")).toHaveLength(5);
    expect(searchTools(tools, "search", undefined, 50)).toHaveLength(50);
    expect(searchTools(tools, "search", undefined, 100)).toHaveLength(50);
    expect(searchTools(tools.slice(0, 1), "search")).toEqual([tools[0]]);
    const changed = tool("fixture", "lookup", "Retrieve records");
    expect(searchTools([changed], "search")).toEqual([]);
    expect(searchTools([changed], "retrieve")).toEqual([changed]);
  });
  test("bounds schemas and strips terminal controls", () => {
    expect(() =>
      prepareTool("a", "id", { name: "x", inputSchema: { type: "array" } }),
    ).toThrow();
    expect(() =>
      prepareTool("a", "id", {
        name: "x",
        inputSchema: { type: "object", description: "a".repeat(70_000) },
      }),
    ).toThrow();
    expect(plain("\x1b[31mhello\x1b[0m\u202eevil")).toBe("helloevil");
  });
});
