import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { serverMatrix } from "./management.js";
import type { ServerStatus } from "./runtime.js";

export const STATUS_ENTRY = "mcp-status";

export interface StatusSnapshot {
  servers: ServerStatus[];
  loaded: [string, number][];
}

/** A transcript snapshot, not a live widget or a message in the model's context. */
export function statusPanel(snapshot: StatusSnapshot, theme: Theme): Component {
  const loaded = new Map(snapshot.loaded);
  return {
    render(width) {
      if (width <= 0) return [];
      const padding = width > 2 ? 1 : 0;
      const prefix = " ".repeat(padding);
      return serverMatrix(snapshot.servers, loaded, width - padding * 2, theme)
        .split("\n").map((row) => prefix + row);
    },
    // Styling and layout are recomputed on every render, including theme changes.
    invalidate() {},
  };
}
