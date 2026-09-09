import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { plain } from "./catalog.js";
import type { DisplayBlock } from "./output.js";

/** Format tokens rather than parsed values: preserve large numbers and duplicate keys. */
export function formatBlock(
  text: string,
  block: Partial<DisplayBlock>,
  theme: Theme,
): string {
  const fallback = plain(text);
  if (
    block.truncated ||
    block.resourceLink ||
    Buffer.byteLength(text) > DEFAULT_MAX_BYTES
  )
    return fallback;
  const mime = block.mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const explicitJson =
    mime === "application/json" ||
    mime === "text/json" ||
    /^application\/[^\s/;]+\+json$/.test(mime ?? "");
  if (mime && !explicitJson) return fallback;
  if (!explicitJson && !block.structured && !/^[\s]*[\[{]/.test(text))
    return fallback;
  try {
    JSON.parse(text);
  } catch {
    return fallback;
  }
  const tokens =
    text.match(
      /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g,
    ) ?? [];
  const pieces: { text: string; color?: Parameters<Theme["fg"]>[0] }[] = [];
  let depth = 0;
  let bytes = 0;
  let lines = 1;
  const add = (value: string, color?: Parameters<Theme["fg"]>[0]) => {
    bytes += Buffer.byteLength(value);
    lines += value.split("\n").length - 1;
    pieces.push({ text: value, color });
  };
  const newline = () => add("\n" + "  ".repeat(depth));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "{" || token === "[") {
      add(token, "syntaxPunctuation");
      depth++;
      if (depth > 100) return fallback;
      if (tokens[i + 1] !== "}" && tokens[i + 1] !== "]") newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[i - 1] !== "{" && tokens[i - 1] !== "[") newline();
      add(token, "syntaxPunctuation");
    } else if (token === ",") {
      add(token, "syntaxPunctuation");
      newline();
    } else if (token === ":") {
      add(":", "syntaxPunctuation");
      add(" ");
    } else {
      add(
        token,
        token.startsWith('"')
          ? tokens[i + 1] === ":"
            ? "syntaxVariable"
            : "syntaxString"
          : /^(true|false|null)$/.test(token)
            ? "syntaxKeyword"
            : "syntaxNumber",
      );
    }
    // Formatting must not turn a compact response into an unbounded display.
    if (bytes > DEFAULT_MAX_BYTES || lines > DEFAULT_MAX_LINES) return fallback;
  }
  return pieces
    .map(({ text: value, color }) =>
      color ? theme.fg(color, plain(value)) : value,
    )
    .join("");
}

export function formatOutput(
  text: string,
  blocks: DisplayBlock[] | undefined,
  theme: Theme,
): string {
  if (!blocks) return plain(text);
  let cursor = 0;
  let extraBytes = 0;
  let extraLines = 0;
  const output: string[] = [];
  for (const block of blocks) {
    // Ignore invalid/stale metadata instead of hiding or repeating result text.
    if (
      !Number.isInteger(block.start) ||
      !Number.isInteger(block.end) ||
      block.start < cursor ||
      block.end < block.start ||
      block.end > text.length
    )
      return plain(text);
    output.push(plain(text.slice(cursor, block.start)));
    const source = text.slice(block.start, block.end);
    const formatted = formatBlock(source, block, theme);
    const visible = plain(formatted);
    extraBytes += Math.max(
      0,
      Buffer.byteLength(visible) - Buffer.byteLength(source),
    );
    extraLines += Math.max(
      0,
      visible.split("\n").length - source.split("\n").length,
    );
    // Bound total expansion as well as each individual block. Keep spill notices.
    if (extraBytes > DEFAULT_MAX_BYTES || extraLines > DEFAULT_MAX_LINES)
      return plain(text);
    output.push(formatted);
    cursor = block.end;
  }
  output.push(plain(text.slice(cursor)));
  return output.join("");
}
