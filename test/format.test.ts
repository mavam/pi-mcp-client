import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatBlock, formatOutput } from "../src/format.js";
import { convertResult } from "../src/output.js";
import { renderResult } from "../src/render.js";

const theme = {
  fg: (_: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("pretty-prints JSON without changing numeric tokens, key order, or duplicate keys", () => {
  const input =
    '{"2":9007199254740993,"1":1e999,"2":-0,"s":"a\\n\\\"b","nested":[{},[],true,false,null]}';
  expect(formatBlock(input, {}, theme)).toBe(
    [
      "{",
      '  "2": 9007199254740993,',
      '  "1": 1e999,',
      '  "2": -0,',
      '  "s": "a\\n\\\"b",',
      '  "nested": [',
      "    {},",
      "    [],",
      "    true,",
      "    false,",
      "    null",
      "  ]",
      "}",
    ].join("\n"),
  );
});

test("uses injected syntax colors and sanitizes server terminal escapes", () => {
  const colors: string[] = [];
  const recording = {
    ...theme,
    fg: (color: string, text: string) => {
      colors.push(color);
      return text;
    },
  } as Theme;
  formatBlock('{"k":["text",1,true,null]}', {}, recording);
  expect(new Set(colors)).toEqual(
    new Set([
      "syntaxPunctuation",
      "syntaxVariable",
      "syntaxString",
      "syntaxNumber",
      "syntaxKeyword",
    ]),
  );
  expect(formatBlock('\x1b[31m{"k":1}', {}, recording)).toBe('{"k":1}');
  expect(formatBlock('{"k":"\\u001b[31m"}', {}, recording)).toContain(
    '"\\u001b[31m"',
  );
});

test("explicit MIME types take precedence over detection", () => {
  for (const mimeType of [
    "application/json",
    "Application/Problem+JSON; charset=utf-8",
    "text/json",
  ])
    expect(formatBlock('{"a":1}', { mimeType }, theme)).toBe('{\n  "a": 1\n}');
  for (const mimeType of [
    "text/plain",
    "text/markdown",
    "text/html",
    "application/unknown",
  ])
    expect(formatBlock('{"a":1}', { mimeType }, theme)).toBe('{"a":1}');
  const colors: string[] = [];
  const recording = {
    ...theme,
    fg: (color: string, value: string) => {
      colors.push(color);
      return value;
    },
  } as Theme;
  formatBlock("true", { mimeType: "application/json" }, recording);
  expect(colors).toContain("syntaxKeyword");
});

test("invalid JSON, unlabeled scalars, NDJSON, and incomplete blocks remain plain", () => {
  for (const input of [
    '{"a":',
    '{"a":1,}',
    "true",
    "42",
    '"hello"',
    "null",
    '{"a":1}\n{"b":2}',
    "# Heading",
    "<html/>",
    "a: 1",
  ])
    expect(formatBlock(input, {}, theme)).toBe(input);
  expect(formatBlock('{"a":1}', { truncated: true }, theme)).toBe('{"a":1}');
});

test("bounds formatted output size, lines, and nesting", () => {
  for (const text of [
    JSON.stringify(Array(2100).fill(0)),
    "[".repeat(101) + "0" + "]".repeat(101),
    JSON.stringify({ value: "x".repeat(52_000) }),
  ])
    expect(formatBlock(text, {}, theme)).toBe(text);
});

test("retains block metadata without changing or duplicating model-facing text", async () => {
  const result = await convertResult(
    {
      content: [
        { type: "text", text: "Intro 界\x1b[31m" },
        { type: "text", text: '{"a":1}' },
        {
          type: "resource",
          resource: {
            uri: "test:///plain",
            mimeType: "text/plain",
            text: '{"b":2}',
          },
        },
        {
          type: "resource",
          resource: {
            uri: "test:///json",
            mimeType: "application/json",
            text: '{"c":3}',
          },
        },
        {
          type: "resource_link",
          uri: "test:///link",
          name: "Linked JSON",
          mimeType: "application/json",
        },
      ],
      structuredContent: { d: 4 },
    },
    "fixture.tool",
  );
  const text = result.content[0]!;
  expect(text.type).toBe("text");
  if (text.type !== "text") return;
  expect(text.text).toBe(
    'Intro 界\x1b[31m\n\n{"a":1}\n\n{"b":2}\n\n{"c":3}\n\nLinked JSON: test:///link\n\n{\n  "d": 4\n}',
  );
  const blocks = result.details.displayBlocks!;
  expect(
    blocks.map((block) => text.text.slice(block.start, block.end)),
  ).toHaveLength(6);
  expect(blocks[2]?.mimeType).toBe("text/plain");
  expect(blocks[3]?.mimeType).toBe("application/json");
  expect(blocks[4]?.mimeType).toBe("application/json");
  expect(blocks[4]?.resourceLink).toBe(true);
  expect(blocks[5]?.structured).toBe(true);
  expect(JSON.stringify(blocks)).not.toContain("Intro");
  expect(formatOutput(text.text, blocks, theme)).toBe(
    'Intro 界\n\n{\n  "a": 1\n}\n\n{"b":2}\n\n{\n  "c": 3\n}\n\nLinked JSON: test:///link\n\n{\n  "d": 4\n}',
  );
});

test("truncated blocks and spill notices stay plain, with no full payload in details", async () => {
  const result = await convertResult(
    {
      content: [
        { type: "text", text: '{"a":1}' },
        {
          type: "resource",
          resource: {
            uri: "test:///large",
            mimeType: "application/json",
            text: "[\n" + "0,\n".repeat(3000) + "0\n]",
          },
        },
      ],
    },
    "fixture.tool",
  );
  try {
    expect(result.details.displayBlocks?.[1]?.truncated).toBe(true);
    expect(JSON.stringify(result.details).length).toBeLessThan(700);
    const text = result.content[0]!;
    if (text.type !== "text") throw new Error("Expected text");
    const rendered = formatOutput(
      text.text,
      result.details.displayBlocks,
      theme,
    );
    expect(rendered).toStartWith('{\n  "a": 1\n}\n\n[\n0,');
    expect(rendered).toContain(
      `Full MCP result: ${result.details.fullOutputPath}`,
    );
  } finally {
    await rm(dirname(result.details.fullOutputPath!), {
      recursive: true,
      force: true,
    });
  }
});

test("expanded JSON is width-safe, collapse/partial stay compact, and themes refresh", async () => {
  const result = await convertResult(
    { content: [{ type: "text", text: '{"界":"long long long","ok":true}' }] },
    "fixture.tool",
  );
  let color = "31";
  const ansiTheme = {
    ...theme,
    fg: (_: string, text: string) => `\x1b[${color}m${text}\x1b[39m`,
  } as Theme;
  const component = renderResult(
    result,
    { expanded: true, isPartial: false },
    ansiTheme,
    false,
  );
  for (const width of [0, 1, 2, 10, 80])
    expect(
      component.render(width).every((row) => visibleWidth(row) <= width),
    ).toBe(true);
  expect(component.render(80).join("\n")).toContain("\x1b[31m");
  color = "32";
  component.invalidate();
  expect(component.render(80).join("\n")).not.toContain("\x1b[31m");
  for (const options of [
    { expanded: false, isPartial: false },
    { expanded: true, isPartial: true },
  ])
    expect(
      renderResult(result, options, theme, false)
        .render(80)
        .map((row) => row.trimEnd()),
    ).toEqual(["✔︎ fixture.tool"]);
});

test("older sessions detect JSON without metadata; malformed offsets safely fall back", () => {
  const text = '{"a":1}';
  expect(formatOutput(text, undefined, theme)).toBe('{\n  "a": 1\n}');
  expect(formatOutput(text, [{ start: -1, end: 10 }], theme)).toBe(text);
});

test("bounds aggregate formatting expansion across multiple blocks", async () => {
  const result = await convertResult(
    {
      content: Array.from({ length: 3 }, () => ({
        type: "text" as const,
        text: JSON.stringify(Array(900).fill(0)),
      })),
    },
    "fixture.tool",
  );
  const part = result.content[0]!;
  if (part.type !== "text") throw new Error("Expected text");
  expect(formatOutput(part.text, result.details.displayBlocks, theme)).toBe(
    part.text,
  );
});
