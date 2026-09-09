import { expect, test } from "bun:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { promptSelector } from "../src/prompt-selector.js";

function fixture() {
  const colors: [string, string][] = [];
  const bold: string[] = [];
  const theme = {
    fg: (color: string, text: string) => { colors.push([color, text]); return text; },
    bold: (text: string) => { bold.push(text); return text; },
  } as unknown as Theme;
  const keys = {
    matches: (data: string, action: string) => data === action,
    getKeys: (action: string) => [action.split(".").at(-1)!],
  } as unknown as KeybindingsManager;
  const selected: (string | undefined)[] = [];
  const component = promptSelector(
    "prompt-demo · explain\nExplain a topic\nArguments are sent only when you fetch a preview.",
    ["topic", "Fetch preview", "Cancel"], theme, keys,
    (choice) => selected.push(choice), () => {},
  );
  return { colors, bold, component, selected };
}

test("only the prompt heading is bold and accented; explanatory text is normal", () => {
  const f = fixture();
  const output = f.component.render(100).map((line) => line.trimEnd()).join("\n");
  expect(output).toContain("prompt-demo · explain\n\nExplain a topic");
  expect(output).toContain("Arguments are sent only when you fetch a preview.");
  expect(f.bold).toEqual(["prompt-demo · explain"]);
  expect(f.colors).toContainEqual(["accent", "prompt-demo · explain"]);
  expect(f.colors).toContainEqual(["text", "Explain a topic\nArguments are sent only when you fetch a preview."]);
  expect(f.colors.filter(([color]) => color === "accent").some(([, text]) => text.includes("Arguments"))).toBe(false);
});

test("prompt selectors use the injected keybindings for navigation and selection", () => {
  const f = fixture();
  f.component.handleInput!("tui.select.down");
  f.component.handleInput!("tui.select.confirm");
  expect(f.selected).toEqual(["Fetch preview"]);
});

test("prompt selectors allow cancellation without selecting an option", () => {
  const f = fixture();
  f.component.handleInput!("tui.select.cancel");
  expect(f.selected).toEqual([undefined]);
});
