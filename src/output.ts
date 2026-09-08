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

export type RowState = "candidate" | "active" | "queued" | "running" | "done" | "failed" | "cancelled";
export interface DisplayRow {
  label: string;
  description?: string;
  inlineDescription?: string;
  state: RowState;
}
/** Character offsets into the model-facing text, without duplicating payloads. */
export interface DisplayBlock {
  start: number;
  end: number;
  mimeType?: string;
  structured?: boolean;
  resourceLink?: boolean;
  truncated?: boolean;
}
export interface ClientDetails {
  mcpClient: 1;
  rows: DisplayRow[];
  failed?: boolean;
  diagnostics?: Diagnostic[];
  loaded?: CatalogTool[];
  candidates?: CatalogTool[];
  /** Search-only display notes; omit the duplicated model response in the TUI. */
  searchNotes?: string[];
  fullOutputPath?: string;
  displayBlocks?: DisplayBlock[];
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
  const blocks: DisplayBlock[] = [];
  let offset = 0;
  const append = (text: string, metadata: Partial<DisplayBlock> = {}) => {
    const start = offset + (texts.length ? 2 : 0);
    offset = start + text.length;
    texts.push(text);
    blocks.push({ ...metadata, start, end: offset });
  };
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  let imageBytes = 0;
  let needsSpill = false;
  for (const part of result.content ?? []) {
    if (part.type === "text") append(part.text);
    else if (
      part.type === "image" &&
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType) &&
      imageBytes + part.data.length <= 8 * 1024 * 1024
    ) {
      images.push({ type: "image", data: part.data, mimeType: part.mimeType });
      imageBytes += part.data.length;
    } else if (part.type === "resource" && "text" in part.resource)
      append(part.resource.text, { mimeType: part.resource.mimeType });
    // The MIME type describes the linked resource, not this textual label.
    else if (part.type === "resource_link")
      append(`${part.name}: ${part.uri}`, {
        mimeType: part.mimeType,
        resourceLink: true,
      });
    else {
      append(`[${part.type} content saved in full result file]`, {
        mimeType: "text/plain",
      });
      needsSpill = true;
    }
  }
  if (result.structuredContent !== undefined)
    append(JSON.stringify(result.structuredContent, null, 2), { structured: true });
  const truncated = truncateHead(texts.join("\n\n"));
  let text = truncated.content;
  const details: ClientDetails = {
    mcpClient: 1,
    displayBlocks: blocks
      .filter((block) => block.start < text.length)
      .map((block) => ({
        ...block,
        end: Math.min(block.end, text.length),
        ...(block.end > text.length ? { truncated: true } : {}),
      })),
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
