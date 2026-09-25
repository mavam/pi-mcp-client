import { expect, test } from "bun:test";
import { BorderedLoader, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { loginSummary } from "../src/authorization.js";
import { reviewAuthorization } from "../src/authorization-review.js";

for (const reviewed of [false, true]) test(`sign-in summaries remain bounded (reviewed=${reviewed})`, () => {
  const oauthScopes = Array.from({ length: 100 }, (_, i) => `scope:${i}:`.padEnd(256, "x"));
  const summary = loginSummary({ oauthScopes }, reviewed);
  expect(summary).toContain(`100 ${reviewed ? "reviewed" : "configured"} scopes`);
  expect(summary).toContain("http://127.0.0.1:19847/callback");
  expect(summary.length).toBeLessThan(120);
  initTheme("dark", false);
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const loader = new BorderedLoader({ requestRender() {} } as TUI, theme,
    `Signing in to example…\n${summary}\nOpening browser. Esc to cancel.`);
  try {
    for (const width of [40, 80]) expect(loader.render(width).length).toBeLessThan(18);
  } finally { loader.dispose(); }
});

for (const known of [false, true]) test(`scope review communicates grant uncertainty (known=${known})`, async () => {
  const pages: string[] = [];
  const ctx = { mode: "rpc", ui: { select: async (title: string, choices: string[]) => {
    pages.push(title);
    return choices.includes("Next page") ? "Next page" : "Approve sign-in";
  } } } as unknown as ExtensionContext;
  expect(await reviewAuthorization(ctx, "example", ["write"], ["write"], known, new AbortController().signal)).toBe(true);
  const text = pages.join("\n").replace(/\s+/gu, " ");
  expect(text.includes("Previously granted scopes are unknown and may not be retained")).toBe(!known);
});
