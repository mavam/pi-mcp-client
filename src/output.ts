import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  truncateHead,
  withFileMutationQueue,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { CatalogTool } from "./catalog.js";
import { diagnostic, type Diagnostic } from "./diagnostics.js";

export type RowState = "queued" | "running" | "done" | "failed" | "cancelled";
export interface DisplayRow {
  label: string;
  description?: string;
  state: RowState;
}
export interface ClientDetails {
  mcpClient: 1;
  rows: DisplayRow[];
  failed?: boolean;
  diagnostics?: Diagnostic[];
  loaded?: CatalogTool[];
  /** Search-only display notes; omit the duplicated model response in the TUI. */
  searchNotes?: string[];
  fullOutputPath?: string;
}
export function textResult(
  text: string,
  details: ClientDetails,
): AgentToolResult<ClientDetails> {
  return { content: [{ type: "text", text }], details };
}

export async function convertResult(
  result: CallToolResult,
  label: string,
): Promise<AgentToolResult<ClientDetails>> {
  const texts: string[] = [];
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  let imageBytes = 0;
  let needsSpill = false;
  for (const part of result.content ?? []) {
    if (part.type === "text") texts.push(part.text);
    else if (
      part.type === "image" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType) &&
      imageBytes + part.data.length <= 8 * 1024 * 1024
    ) {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      imageBytes += part.data.length;
    } else if (part.type === "resource" && "text" in part.resource)
      texts.push(part.resource.text);
    else if (part.type === "resource_link") texts.push(`${part.name}: ${part.uri}`);
    else {
      texts.push(`[${part.type} content saved in full result file]`);
      needsSpill = true;
    }
  }
  if (result.structuredContent !== undefined)
    texts.push(JSON.stringify(result.structuredContent, null, 2));
  const truncated = truncateHead(texts.join("\n\n"));
  let text = truncated.content;
  const details: ClientDetails = {
    mcpClient: 1,
    failed: result.isError === true,
    ...(result.isError
      ? {
          diagnostics: [
            diagnostic("tool_error", {
              server: label.split(".")[0],
              operation: "call",
            }),
          ],
        }
      : {}),
    rows: [{ label, state: result.isError ? "failed" : "done" }],
  };
  if (truncated.truncated || needsSpill) {
    const path = join(await mkdtemp(join(tmpdir(), "pi-mcp-client-")), "result.json");
    await withFileMutationQueue(path, () =>
      writeFile(path, JSON.stringify(result), { mode: 0o600 }),
    );
    details.fullOutputPath = path;
    text += `\n\nFull MCP result: ${path}`;
  }
  return {
    content: [...(text ? [{ type: "text" as const, text }] : []), ...images],
    details,
  };
}
