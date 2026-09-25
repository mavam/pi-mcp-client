import { expect, test } from "bun:test";
import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { authorizationReview } from "../src/authorization-review.js";

for (const width of [24, 40, 80]) test(`permission review remains bounded at ${width}×24`, () => {
  const approvals: boolean[] = [];
  const scopes = Array.from({ length: 30 }, (_, i) => `scope:${i}:${"x".repeat(80)}`);
  scopes.push("admin:delete");
  const theme = { fg: (_: string, text: string) => text } as Theme;
  const keys = { matches: (input: string, key: string) => input === key } as KeybindingsManager;
  const component = authorizationReview("example", scopes.join("\n"), () => 24, theme, keys, value => approvals.push(value), () => {});
  let last: string[] = [];
  for (let i = 0; i < 200; i++) {
    last = component.render(width);
    expect(last.length).toBeLessThanOrEqual(16);
    expect(last.some(line => line.includes("cancel"))).toBe(true);
    expect(last.every(line => line.length <= width)).toBe(true);
    if (last.some(line => line.includes("a: approve"))) break;
    component.handleInput!("a");
    expect(approvals).toEqual([]);
    component.handleInput!("tui.select.confirm");
  }
  expect(last.join("\n")).toContain("admin:delete");
  component.handleInput!("tui.select.confirm");
  expect(approvals).toEqual([]);
  component.handleInput!("a");
  expect(approvals).toEqual([true]);
  // Shrinking the terminal resets review rather than exposing a stale approval.
  component.render(10);
  component.handleInput!("a");
  expect(approvals).toEqual([true]);
  component.handleInput!("tui.select.cancel");
  expect(approvals).toEqual([true, false]);
});
