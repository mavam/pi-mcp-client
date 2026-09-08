import { expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.js";
import { renderCall, renderResult } from "../src/render.js";

const theme = {
  fg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("search schema describes the inclusive limit and default at the parameter", () => {
  let search: any;
  extension({
    registerTool: (tool: any) => { search = tool; },
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  const limit = search.parameters.properties.limit;
  expect(limit.minimum).toBe(1);
  expect(limit.maximum).toBe(50);
  expect(limit.default).toBe(5);
  expect(limit.description).toContain("1–50 inclusive");
  expect(limit.description).toContain("default: 5");
  expect(search.parameters.properties.query.description).toContain("focused");
  expect(search.parameters.required ?? []).not.toContain("query");
  expect(search.parameters.required ?? []).not.toContain("activate");
  expect(search.parameters.additionalProperties).toBe(false);
  expect(search.parameters).not.toHaveProperty("anyOf");
  expect(search.parameters.properties.activate.minItems).toBe(1);
  expect(search.parameters.properties.activate.maxItems).toBe(50);
  expect(search.description).toContain("Even an exact-name query is discovery-only");
});

test("search renders each tool once, with bounded expanded descriptions and visible warnings", () => {
  const result = {
    content: [{ type: "text", text: "Loaded: mcp__linear__list_teams — model-facing text" }],
    details: {
      mcpClient: 1,
      searchNotes: ["Catalog warning"],
      rows: [
        { label: "linear.list_teams · loaded", description: "List teams " + "界".repeat(200) + "\x1b[31m", state: "done" },
        { label: "linear.get_team · already loaded", state: "done" },
        { label: "other: authentication required", state: "failed" },
        { label: "restricted · not loaded", state: "failed" },
      ],
    },
  };
  for (const expanded of [false, true]) {
    for (const width of [0, 1, 2, 10, 80]) {
      const lines = renderResult(result, { expanded, isPartial: false }, theme, false).render(width);
      expect(lines.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("model-facing text");
      expect(lines.join("\n")).not.toContain("\x1b[31m");
      if (width === 80) {
        expect(lines).toHaveLength(expanded ? 6 : 5);
        expect(lines.join("\n")).toContain("Catalog warning");
        expect(lines.join("\n")).toContain("authentication required");
        expect(lines.join("\n")).toContain("already loaded");
        expect(lines.join("\n")).toContain("not loaded");
        if (expanded) expect(lines[1]).toContain("...");
      }
    }
  }
});

test("candidate rows and both call forms are neutral and width-safe", () => {
  const result = {
    content: [{ type: "text", text: "No tools activated." }],
    details: { mcpClient: 1, candidates: [], searchNotes: [], rows: [
      { label: "linear.get_team — Fetch a team. (required: teamId) [loaded]", state: "candidate" },
    ] },
  };
  for (const expanded of [false, true]) {
    for (const width of [0, 1, 2, 10, 80]) {
      const rows = renderResult(result, { expanded, isPartial: false }, theme, false).render(width);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      if (width === 80) expect(rows[0]).toStartWith("○ linear.get_team");
      for (const args of [{ query: "list teams" }, { activate: ["linear.get_team", "linear.list_teams"] }]) {
        const call = renderCall("mcp search", args, theme, expanded).render(width);
        expect(call.every((row) => visibleWidth(row) <= width)).toBe(true);
        if (width === 80) expect(call.join("\n")).toContain("query" in args ? "list teams" : "linear.get_team");
      }
    }
  }
});

test("empty searches and native results retain useful output", () => {
  const options = { expanded: true, isPartial: false };
  const empty = renderResult({
    content: [{ type: "text", text: "No callable matches found." }],
    details: { mcpClient: 1, searchNotes: [], rows: [{ label: "No matching tools", state: "done" }] },
  }, options, theme, false).render(80);
  expect(empty).toEqual(["✔︎ No matching tools"]);
  const native = renderResult({
    content: [{ type: "text", text: "Native result body" }],
    details: { mcpClient: 1, rows: [{ label: "linear.list_teams", state: "done" }] },
  }, options, theme, false).render(80);
  expect(native.join("\n")).toContain("Native result body");
});
