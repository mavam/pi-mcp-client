import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { serverMatrix } from "../src/management.js";
import { diagnostic } from "../src/diagnostics.js";
import type { ServerStatus } from "../src/runtime.js";

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
  expect(text).toMatch(/✔︎ cloudflare\s+connected\s+12\s+3/);
  expect(text).toContain("▶︎ pending");
  expect(text).toContain("■ disabled");
  expect(text).toContain("✘︎ failed");
  expect(text).toContain("[authentication_required]");
  expect(text).toMatch(/✔︎ empty\s+connected\s+0\s+0/);
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
