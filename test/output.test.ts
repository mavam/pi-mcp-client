import { expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { convertResult } from "../src/output.js";
import { renderCall, renderResult } from "../src/render.js";
import { OAuthProvider, type SecretStore } from "../src/auth.js";

const theme = {
  fg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("preserves text, images, structured output, and MCP failure state", async () => {
  const result = await convertResult(
    {
      content: [
        { type: "text", text: "failure details" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
      structuredContent: { reason: "no" },
      isError: true,
    },
    "fixture.echo",
  );
  expect(result.details.failed).toBe(true);
  expect(result.details.diagnostics?.[0].code).toBe("tool_error");
  expect(result.details.diagnostics?.[0].server).toBe("fixture");
  expect(result.content.some((part) => part.type === "image")).toBe(true);
  expect(JSON.stringify(result.content)).toContain("failure details");
  expect(JSON.stringify(result.content)).toContain("reason");
});

test("spills oversized output to a private file, not result details", async () => {
  const text = "test\n".repeat(3000);
  const result = await convertResult(
    { content: [{ type: "text", text }] },
    "fixture.large",
  );
  const path = result.details.fullOutputPath!;
  try {
    expect(path).toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8")).content[0].text).toBe(text);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result.details).length).toBeLessThan(500);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("renderers bound and sanitize all call and result variants", () => {
  const hostile = "界".repeat(100) + "\x1b[31m\u202e";
  const states = ["candidate", "active", "queued", "running", "done", "failed", "cancelled"] as const;
  for (const expanded of [false, true]) {
    for (const width of [0, 1, 2, 10, 80]) {
      const calls = [
        renderCall("mcp discover", { query: hostile, server: hostile }, theme, expanded),
        renderCall("mcp activate", { activate: [hostile, hostile] }, theme, expanded),
        renderCall("native", { input: hostile }, theme, expanded),
      ];
      const results = states.flatMap((state) => [false, true].map((isPartial) =>
        renderResult({
          content: [{ type: "text", text: hostile }],
          details: { mcpClient: 1, rows: [{
            label: hostile, description: hostile, inlineDescription: hostile, state,
          }] },
        }, { expanded, isPartial }, theme, state === "failed"),
      ));
      for (const component of [...calls, ...results]) {
        const rows = component.render(width);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        expect(rows.join("")).not.toContain("\x1b[31m");
        expect(rows.join("")).not.toContain("\u202e");
      }
    }
  }
});

test("catalog results suppress duplicate content while native results expose their body", () => {
  for (const catalog of [false, true]) {
    const result = {
      content: [{ type: "text", text: "Response body" }],
      details: {
        mcpClient: 1,
        rows: [{ label: "tool", state: "done" }],
        ...(catalog ? { searchNotes: ["Catalog warning"] } : {}),
      },
    };
    const text = renderResult(result, { expanded: true, isPartial: false }, theme, false)
      .render(80).join("\n");
    expect(text.includes("Response body")).toBe(!catalog);
    expect(text.includes("Catalog warning")).toBe(catalog);
  }
});

function store(): SecretStore {
  let data: string | null = null;
  return {
    read: () => data,
    remove: () => { data = null; },
    write: (value) => {
      data = value;
    },
  };
}

test("OAuth credentials bind to server URL and issuer", () => {
  const storage = store();
  const provider = new OAuthProvider({ server: "example", url: "https://a.example/mcp" }, storage);
  provider.saveClientInformation(
    { client_id: "client", issuer: "https://issuer.example" },
    { issuer: "https://issuer.example" },
  );
  provider.saveTokens({
    access_token: "secret",
    token_type: "Bearer",
    issuer: "https://issuer.example",
  });
  expect(
    provider.clientInformation({ issuer: "https://other.example" }),
  ).toBeUndefined();
  expect(provider.tokens({ issuer: "https://other.example" })).toBeUndefined();
  expect(
    new OAuthProvider({ server: "example", url: "https://a.example/mcp" }, storage).tokens()?.access_token,
  ).toBe("secret");
  expect(() => new OAuthProvider({ server: "example", url: "https://b.example/mcp" }, storage)).toThrow(
    "Invalid OAuth credential record",
  );
});

test("OAuth redirect is explicit and transient secrets are not persisted", async () => {
  const storage = store();
  const provider = new OAuthProvider({ server: "example", url: "https://a.example/mcp" }, storage);
  provider.saveCodeVerifier("private-verifier");
  provider.saveTokens({ access_token: "secret", token_type: "Bearer" });
  expect(storage.read()).not.toContain("private-verifier");
  expect(storage.read()).not.toContain(provider.expectedState);
  await expect(
    provider.redirectToAuthorization(new URL("https://auth.example/")),
  ).rejects.toThrow("[authentication_required]");
});
