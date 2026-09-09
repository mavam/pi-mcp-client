import type { GetPromptResult } from "@modelcontextprotocol/client";
import { line, plain } from "./catalog.js";
import { object } from "./config.js";
import { failure } from "./diagnostics.js";

export interface CatalogPrompt {
  server: string;
  identity: string;
  name: string;
  title?: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && !!value && value.length <= 512 && line(value) === value;
}

export function preparePrompt(server: string, identity: string, value: unknown): CatalogPrompt {
  const invalid = () => failure("protocol_error", { server, operation: "search" });
  if (!object(value) || !identifier(value.name) ||
      (value.description !== undefined && typeof value.description !== "string") ||
      (value.title !== undefined && typeof value.title !== "string") ||
      (value.arguments !== undefined && !Array.isArray(value.arguments))) throw invalid();
  const args = value.arguments ?? [];
  if (args.length > 100) throw invalid();
  const seen = new Set<string>();
  const arguments_ = args.map((argument: unknown) => {
    if (!object(argument) || !identifier(argument.name) || seen.has(argument.name) ||
        (argument.description !== undefined && typeof argument.description !== "string") ||
        (argument.required !== undefined && typeof argument.required !== "boolean")) throw invalid();
    seen.add(argument.name);
    return { name: argument.name, description: plain(argument.description as string ?? "").slice(0, 8000), required: argument.required === true };
  });
  return {
    server, identity, name: value.name,
    ...(value.title === undefined ? {} : { title: plain(value.title as string).slice(0, 512) }),
    description: plain(value.description as string ?? "No description supplied.").slice(0, 8000),
    arguments: arguments_,
  };
}

export function validPromptArguments(prompt: CatalogPrompt, args: Record<string, string>): boolean {
  return Object.entries(args).every(([key, value]) => prompt.arguments.some((arg) => arg.name === key) &&
    typeof value === "string" && value.length <= 4096) &&
    prompt.arguments.every((arg) => !arg.required || Object.hasOwn(args, arg.name)) &&
    Buffer.byteLength(JSON.stringify(args)) <= 64 * 1024;
}

/** Quoted command tokens, never shell interpolation. */
export function promptCommand(prompt: Pick<CatalogPrompt, "server" | "name">): string {
  const quote = (word: string) => /^[A-Za-z0-9_.:/-]+$/u.test(word) ? word : `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `/mcp prompt ${quote(prompt.server)} ${quote(prompt.name)}`;
}

export interface PromptSnapshot { body: string; preview: string; count: number; usable: boolean }

const promptText = (value: string) => plain(value).replace(/\r\n?/g, "\n");

/** Keep message roles as data, not synthetic conversation turns. Never dereference links. */
export function preparePromptSnapshot(result: GetPromptResult, server: string): PromptSnapshot {
  const invalid = () => failure("protocol_error", { server, operation: "prompt" });
  if (!object(result) || !Array.isArray(result.messages) || !result.messages.length) throw invalid();
  if (Buffer.byteLength(JSON.stringify(result)) > 50 * 1024) throw failure("prompt_too_large", { server, operation: "prompt" });
  let usable = true;
  const previews: string[] = [];
  const messages = result.messages.map((message, index) => {
    if (!["user", "assistant"].includes(message.role) || !object(message.content)) throw invalid();
    const content = message.content;
    let block: object;
    let preview: string;
    if (content.type === "text" && typeof content.text === "string") {
      block = { type: "text", text: promptText(content.text) };
      preview = promptText(content.text);
    } else if (content.type === "resource" && object(content.resource) && "text" in content.resource && typeof content.resource.text === "string") {
      block = { type: "resource", uri: plain(String(content.resource.uri)),
        mimeType: plain(String(content.resource.mimeType ?? "text/plain")), text: promptText(content.resource.text) };
      preview = `Embedded resource: ${line(String(content.resource.uri))} · ${line(String(content.resource.mimeType ?? "text/plain"))}\n${promptText(content.resource.text)}`;
    } else {
      usable = false;
      block = { type: line(String(content.type)), unsupported: true, bytes: Buffer.byteLength(JSON.stringify(content)) };
      preview = `Unsupported ${line(String(content.type))} content · ${Buffer.byteLength(JSON.stringify(content))} bytes`;
    }
    previews.push(`Message ${index + 1} · ${message.role} (server supplied)\n${preview}`);
    return { role: message.role, content: block };
  });
  const description = typeof result.description === "string" ? promptText(result.description) : undefined;
  const body = JSON.stringify({ server, ...(description === undefined ? {} : { description }), messages }, null, 2);
  const preview = [...(description ? [description] : []), ...previews].join("\n\n");
  if (preview.split("\n").length > 2000 || body.split("\n").length > 2000 || Buffer.byteLength(body) > 50 * 1024)
    throw failure("prompt_too_large", { server, operation: "prompt" });
  return { body, preview, count: messages.length, usable };
}
