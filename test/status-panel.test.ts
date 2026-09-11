import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { plain } from "../src/catalog.js";
import { diagnostic } from "../src/diagnostics.js";
import { serverMatrix } from "../src/management.js";
import { statusPanel, type StatusSnapshot } from "../src/status-panel.js";

function recordingTheme() {
  const calls: [string, string][] = [];
  const bold: string[] = [];
  let ansi = 34;
  const theme = {
    fg: (color: string, text: string) => {
      calls.push([color, text]);
      return `\x1b[${ansi}m${text}\x1b[39m`;
    },
    bold: (text: string) => {
      bold.push(text);
      return `\x1b[1m${text}\x1b[22m`;
    },
  } as Theme;
  return { theme, calls, bold, change: () => { ansi = 35; } };
}

const snapshot: StatusSnapshot = {
  servers: [
    { name: "idle", state: "disconnected" },
    { name: "connected", state: "connected", catalogSize: 12 },
    { name: "connecting", state: "connecting" },
    { name: "disabled", state: "disabled" },
    { name: "failed", state: "failed", error: diagnostic("authentication_required", { operation: "connect" }) },
    { name: "empty", state: "connected", catalogSize: 0 },
  ],
  loaded: [["connected", 3]],
};

test("status panel uses theme colors, bold names, and textual state labels", () => {
  const { theme, calls, bold } = recordingTheme();
  const text = statusPanel(snapshot, theme).render(100).map(plain).join("\n");
  expect(text).not.toContain("MCP servers");
  expect(text.split("\n")[0]).toContain("Server");
  for (const server of snapshot.servers) expect(bold.map((s) => s.trim())).toContain(server.name);
  for (const [color, glyph] of [["muted", "○"], ["success", "●"], ["warning", "▶︎"], ["error", "✘︎"], ["dim", "○"]]) {
    expect(calls).toContainEqual([color, glyph]);
  }
  expect(calls).toContainEqual(["accent", "     3"]);
  expect(text).toMatch(/connected\s+connected\s+12\s+3/);
  expect(text).toMatch(/empty\s+connected\s+0\s+0/);
  expect(text).toContain("[authentication_required]");
  expect(text).toContain("— = catalog not fetched.");
});

test("status panel reflows on resize and recomputes colors after invalidation", () => {
  const { theme, change } = recordingTheme();
  const panel = statusPanel(snapshot, theme);
  const wide = panel.render(100);
  expect(wide.map(plain).join("\n")).toContain("Loaded");
  const narrow = panel.render(38).map(plain).join("\n");
  expect(narrow).toContain("12 tools · 3 loaded");
  expect(narrow).not.toContain("Loaded");
  expect(panel.render(100)).toEqual(wide);
  change();
  panel.invalidate();
  const changed = panel.render(100);
  expect(changed).not.toEqual(wide);
  expect(changed.map(plain)).toEqual(wide.map(plain));
});

test("all panel lines fit, including empty states, Unicode, and terminal control input", () => {
  const { theme } = recordingTheme();
  const hostile: StatusSnapshot = {
    servers: [{
      name: "\x1b[31m界\n\t".repeat(25), state: "failed", catalogSize: 1234567,
      error: { ...diagnostic("connection_failed", { operation: "connect" }), message: "\x1b[2Jbad\n\t界 ".repeat(30) },
    }],
    loaded: [],
  };
  for (const data of [snapshot, hostile, { servers: [], loaded: [] } satisfies StatusSnapshot]) {
    const panel = statusPanel(data, theme);
    for (const width of [0, 1, 2, 3, 10, 38, 41, 42, 60, 80, 120]) {
      const rows = panel.render(width);
      for (const row of rows) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        expect(row).not.toContain("\n");
        expect(row).not.toContain("\t");
        expect(row).not.toContain("\x1b[31m");
        expect(row).not.toContain("\x1b[2J");
      }
      const unstyled = serverMatrix(data.servers, new Map(data.loaded), width);
      expect(unstyled).not.toContain("\x1b");
      for (const row of unstyled.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    }
  }
});

test("table columns align by display width rather than string length", () => {
  const rows = serverMatrix([
    { name: "界界", state: "connected", catalogSize: 8 },
    { name: "e\u0301", state: "connected", catalogSize: 9 },
  ], new Map(), 80).split("\n").filter((row) => row.startsWith("●"));
  expect(rows).toHaveLength(2);
  expect(visibleWidth(rows[0].slice(0, rows[0].indexOf("connected"))))
    .toBe(visibleWidth(rows[1].slice(0, rows[1].indexOf("connected"))));
});
