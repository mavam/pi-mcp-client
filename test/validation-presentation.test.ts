import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderResult } from "../src/render.js";

const theme = {
  fg: (_: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as Theme;

function validationError(): string {
  try {
    validateToolArguments(
      {
        name: "mcp__linear__list_teams",
        description: "List teams",
        parameters: Type.Object(
          { limit: Type.Optional(Type.Number()) },
          { additionalProperties: false },
        ),
      },
      {
        type: "toolCall",
        id: "test",
        name: "mcp__linear__list_teams",
        arguments: { limit: 1, fields: ["id", "name"] },
      },
    );
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected validation to fail");
}

test("Pi validation errors have a compact status and one highlighted argument payload", () => {
  const text = validationError();
  const result = { content: [{ type: "text", text }] };
  const render = (expanded: boolean, width = 120) =>
    renderResult(result, { expanded, isPartial: false }, theme, true)
      .render(width)
      .map((row) => row.trimEnd());
  expect(render(false).join("\n")).not.toContain("Received arguments:");
  const expanded = render(true).join("\n");
  expect(expanded).toContain("must not have additional properties");
  expect(expanded.match(/Received arguments:/g)).toHaveLength(1);
  expect(expanded.match(/"fields"/g)).toHaveLength(1);
  expect(expanded).not.toContain("Validation failed for tool");
  expect(result.content[0]!.text).toBe(text);
  for (const width of [0, 1, 2, 10, 80])
    expect(render(true, width).every((row) => visibleWidth(row) <= width)).toBe(
      true,
    );
});

test("other framework errors show their details once and sanitize terminal controls", () => {
  const text = "Execution blocked\nReason: \x1b[31mnot permitted";
  const result = { content: [{ type: "text", text }] };
  const rows = renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    true,
  )
    .render(120)
    .map((row) => row.trimEnd());
  const rendered = rows.join("\n");
  expect(rendered).not.toContain("\x1b");
  expect(rendered.match(/Execution blocked/g)).toHaveLength(1);
  expect(rendered.match(/not permitted/g)).toHaveLength(1);
});

test("server text resembling validation errors is not reinterpreted", () => {
  const text = validationError();
  const result = {
    content: [{ type: "text", text }],
    details: {
      mcpClient: 1,
      rows: [{ label: "server.tool", state: "failed" }],
    },
  };
  const rendered = renderResult(
    result,
    { expanded: true, isPartial: false },
    theme,
    true,
  )
    .render(120)
    .join("\n");
  expect(rendered).toContain("Validation failed for tool");
  expect(rendered).not.toContain("Invalid tool arguments");
});
