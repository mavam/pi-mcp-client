import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { line, plain } from "./catalog.js";
import { object } from "./config.js";
import { formatBlock, formatOutput } from "./format.js";
import type { ClientDetails, RowState } from "./output.js";

// Same glyphs and palette as Webfox's input status rows.
const states = {
  candidate: { glyph: "○", color: "dim" },
  queued: { glyph: "●", color: "dim" },
  running: { glyph: "▶︎", color: "muted" },
  done: { glyph: "✔︎", color: "success" },
  failed: { glyph: "✘︎", color: "error" },
  cancelled: { glyph: "■", color: "dim" },
} as const;

export function renderCall(
  title: string,
  args: unknown,
  theme: Theme,
  expanded: boolean,
): Component {
  const values = object(args) ? args : {};
  const preview = Object.entries(values)
    .map(([key, value]) => `${line(key)}=${line(JSON.stringify(value) ?? "")}`)
    .join(" ");
  return {
    render(width) {
      if (width <= 0) return [];
      const text =
        theme.fg("toolTitle", theme.bold(line(title))) +
        (preview ? theme.fg("dim", ` ${preview}`) : "");
      if (expanded)
        return new Text(text, 0, 0)
          .render(width)
          .map((row) => truncateToWidth(row, width));
      const key = keyText("app.tools.expand");
      return [
        truncateToWidth(
          text + (key ? theme.fg("muted", ` (${key} to expand)`) : ""),
          width,
        ),
      ];
    },
    invalidate() {},
  };
}

/** Only recognize Pi's validation wrapper, not arbitrary embedded JSON. */
function formatValidation(text: string, theme: Theme): string {
  const marker = /\r?\n\r?\nReceived arguments:\r?\n/.exec(text);
  if (!marker) return plain(text);
  const start = marker.index + marker[0].length;
  return plain(text.slice(0, start)) + formatBlock(text.slice(start), {}, theme);
}

export function renderResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  isError: boolean,
): Component {
  const details =
    object(result.details) && result.details.mcpClient === 1
      ? (result.details as unknown as ClientDetails)
      : undefined;
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  // Pi rejects invalid arguments before execute(), so these errors have no
  // client details. Don't repeat their entire payload in the status row.
  const validation = !details && isError
    ? /^Validation failed for tool "[^"\r\n]+":\r?\n([\s\S]*)$/.exec(text)
    : null;
  const body = validation?.[1] ?? text;
  const rows = details?.rows ?? [
    {
      label: validation
        ? "Invalid tool arguments"
        : isError ? "Tool failed" : line(text) || "Working…",
      state: (isError ? "failed" : options.isPartial ? "running" : "done") as RowState,
    },
  ];
  let formattedOutput: string | undefined;
  return {
    render(width) {
      if (width <= 0) return [];
      const lines = rows.flatMap((row) => {
        const status = states[row.state] ?? states.failed;
        const value =
          theme.fg(status.color, status.glyph) +
          " " +
          theme.fg("accent", line(row.label)) +
          (row.inlineDescription
            ? theme.fg("dim", ` ${line(row.inlineDescription)}`)
            : "");
        const rendered = options.expanded && (!details?.searchNotes || row.state === "failed")
          ? new Text(value, 0, 0).render(width).map((x) => truncateToWidth(x, width))
          : [truncateToWidth(value, width)];
        if (options.expanded && row.description)
          rendered.push(truncateToWidth(
            theme.fg("dim", `  ${line(row.description)}`), width,
          ));
        return rendered;
      });
      // Plain text prevents server-supplied terminal escapes from becoming markup.
      for (const note of details?.searchNotes ?? [])
        lines.push(...(options.expanded
          ? new Text(theme.fg("warning", plain(note)), 0, 0).render(width)
          : [theme.fg("warning", line(note))]
        ).map((row) => truncateToWidth(row, width)));
      if (options.expanded && !options.isPartial && text && !details?.searchNotes)
        lines.push(
          ...new Text(
            formattedOutput ??= validation
              ? formatValidation(body, theme)
              : formatOutput(body, details?.displayBlocks, theme),
            0, 0,
          ).render(width).map((x) => truncateToWidth(x, width)),
        );
      if (!options.expanded && details?.fullOutputPath)
        lines.push(
          truncateToWidth(
            theme.fg("dim", `Full result: ${details.fullOutputPath}`),
            width,
          ),
        );
      return lines;
    },
    invalidate() {
      formattedOutput = undefined;
    },
  };
}
