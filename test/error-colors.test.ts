import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { convertResult, type ClientDetails, type RowState } from "../src/output.js";
import { renderResult } from "../src/render.js";

function recordingTheme() {
  const calls: [string, string][] = [];
  const boldCalls: string[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return `\x1b[${color === "error" ? 31 : 34}m${text}\x1b[39m`;
    },
    bold: (text: string) => {
      boldCalls.push(text);
      return `\x1b[1m${text}\x1b[22m`;
    },
  } as unknown as Theme;
  return { theme, calls, boldCalls };
}

test("all result states keep descriptions dim and reserve error color for failed labels", () => {
  for (const expanded of [false, true]) {
    const { theme, calls } = recordingTheme();
    const states: RowState[] = ["candidate", "active", "queued", "running", "done", "failed", "cancelled"];
    const details: ClientDetails = {
      mcpClient: 1,
      searchNotes: ["Catalog warning"],
      rows: states.map((state) => ({
        state, label: `${state} label`, inlineDescription: `${state} reason`, inlineAction: `${state} action`, description: `${state} detail`,
      })),
    };
    renderResult({ content: [], details }, { expanded, isPartial: false }, theme, false).render(120);
    for (const state of states) {
      expect(calls).toContainEqual([state === "failed" ? "error" : "accent", `${state} label`]);
      expect(calls).toContainEqual(["dim", ` ${state} reason`]);
      expect(calls).toContainEqual(["dim", ` ${state} action`]);
      if (expanded)
        expect(calls).toContainEqual(["dim", `  ${state} detail`]);
    }
    expect(calls).toContainEqual(["warning", "Catalog warning"]);
  }
});

test("discovery diagnostics keep the server red and explanation dim", () => {
  const { theme, calls, boldCalls } = recordingTheme();
  const label = "cloudflare";
  const inlineDescription = "Authentication is required.";
  const inlineAction = "Run /mcp auth cloudflare.";
  for (const expanded of [false, true]) {
    const component = renderResult({
      content: [],
      details: { mcpClient: 1, searchNotes: [], rows: [{ state: "failed", label, inlineDescription, inlineAction }] },
    }, { expanded, isPartial: false }, theme, false);
    for (const width of [0, 1, 2, 10, 80, 240]) {
      const rows = component.render(width);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      component.invalidate();
      expect(component.render(width)).toEqual(rows);
    }
  }
  expect(calls).toContainEqual(["error", "cloudflare"]);
  expect(calls).toContainEqual(["dim", ` ${inlineDescription}`]);
  expect(calls).toContainEqual(["dim", ` ${inlineAction}`]);
  expect(boldCalls.some((text) => text.includes(inlineAction))).toBe(true);
  expect(calls.some(([, text]) => text.includes("cloudflare:") || text.includes("[authentication_required]"))).toBe(false);
});

test("local, framework, and native tool failures use error colors without losing JSON highlighting", async () => {
  const native = await convertResult({
    isError: true,
    content: [{ type: "text", text: "Request denied" }],
    structuredContent: { reason: "denied" },
  }, "server.tool");
  const local = {
    content: [{ type: "text", text: "Unknown identifier" }],
    details: { mcpClient: 1, failed: true, rows: [{ state: "failed", label: "Unknown identifier" }] },
  };
  const validation = { content: [{ type: "text", text: 'Validation failed for tool "test":\n  - Invalid input\n\nReceived arguments:\n{"limit": "bad"}' }] };
  const framework = { content: [{ type: "text", text: "Execution blocked\nNot permitted" }] };
  for (const [result, isError] of [[native, false], [local, false], [validation, true], [framework, true]] as const) {
    const { theme, calls } = recordingTheme();
    const before = JSON.stringify(result);
    renderResult(result, { expanded: true, isPartial: false }, theme, isError).render(240);
    expect(calls.some(([color]) => color === "accent")).toBe(false);
    expect(calls.some(([color, text]) => color === "error" && text.length > 10)).toBe(true);
    if (result === native || result === validation)
      expect(calls.some(([color]) => color === "syntaxVariable")).toBe(true);
    if (result === framework)
      expect(calls).toContainEqual(["error", "Execution blocked\nNot permitted"]);
    expect(JSON.stringify(result)).toBe(before);
  }
});
