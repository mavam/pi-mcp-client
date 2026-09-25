import {
  ProtocolError,
  ProtocolErrorCode,
  type ElicitRequestFormParams,
  type ElicitRequestParams,
  type ElicitRequestURLParams,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { line, plain } from "./catalog.js";

export type FormValue = string | number | boolean | string[];

/** Host dialogs. `select` must close when its signal aborts. */
export interface ElicitationUI {
  select(title: string, choices: string[], signal: AbortSignal): Promise<string | undefined>;
  editor(title: string, value: string): Promise<string | undefined>;
  notify(message: string, type: "info" | "warning" | "error"): void;
  open(url: string): Promise<boolean>;
}

interface Choice { value: string; label: string }
interface FieldBase { name: string; label: string; description: string; required: boolean }
export type Field = FieldBase & (
  | { type: "string"; minLength?: number; maxLength?: number; format?: string; default?: string }
  | { type: "number" | "integer"; minimum?: number; maximum?: number; default?: number }
  | { type: "boolean"; default?: boolean }
  | { type: "choice"; options: Choice[]; default?: string }
  | { type: "multi"; options: Choice[]; minItems?: number; maxItems?: number; default?: string[] }
);

const MAX_FIELDS = 50;
const MAX_CHOICES = 100;
const MAX_TEXT = 8192;
const MAX_CONTENT = 64 * 1024;
export const MAX_REQUIRED = 3;

const invalid = (message: string) => new ProtocolError(ProtocolErrorCode.InvalidParams, message);
const short = (value: unknown, limit: number) => typeof value === "string" ? line(value).slice(0, limit) : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Server text stays data: control characters are removed and length is bounded. */
function message(value: string): string {
  const text = plain(value).split("\n").map((row) => row.trimEnd()).slice(0, 20).join("\n").trim();
  return text.slice(0, 2000) || "(No message supplied.)";
}

function choices(values: Choice[]): Choice[] {
  if (!values.length || values.length > MAX_CHOICES || new Set(values.map((choice) => choice.value)).size !== values.length)
    throw invalid("Elicitation choices are empty, duplicated, or too many.");
  return values.map(({ value, label }) => ({ value, label: short(label, 120) || short(value, 120) || JSON.stringify(value) }));
}

/** The SDK has validated the restricted schema; this maps it to editable fields. */
export function formFields(schema: ElicitRequestFormParams["requestedSchema"]): Field[] {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length > MAX_FIELDS) throw invalid("Elicitation forms are limited to 50 fields.");
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return entries.map(([name, value]): Field => {
    const property = value as Record<string, any>;
    const base = {
      name,
      label: short(property.title, 120) || short(name, 120) || "(unnamed)",
      description: short(property.description, 400),
      required: required.has(name),
    };
    if (property.type === "boolean")
      return { ...base, type: "boolean", default: typeof property.default === "boolean" ? property.default : undefined };
    if (property.type === "number" || property.type === "integer")
      return { ...base, type: property.type, minimum: number(property.minimum), maximum: number(property.maximum), default: number(property.default) };
    if (property.type === "array") {
      const items = property.items ?? {};
      const options = Array.isArray(items.enum)
        ? items.enum.map((value: string) => ({ value, label: value }))
        : (items.anyOf ?? []).map((option: { const: string; title: string }) => ({ value: option.const, label: option.title }));
      return {
        ...base, type: "multi", options: choices(options), minItems: number(property.minItems), maxItems: number(property.maxItems),
        default: Array.isArray(property.default) ? property.default : undefined,
      };
    }
    if (Array.isArray(property.enum) || Array.isArray(property.oneOf)) {
      const options = Array.isArray(property.enum)
        ? property.enum.map((value: string, index: number) => ({ value, label: property.enumNames?.[index] ?? value }))
        : property.oneOf.map((option: { const: string; title: string }) => ({ value: option.const, label: option.title }));
      return { ...base, type: "choice", options: choices(options), default: typeof property.default === "string" ? property.default : undefined };
    }
    return {
      ...base, type: "string", minLength: number(property.minLength), maxLength: number(property.maxLength),
      format: typeof property.format === "string" ? property.format : undefined,
      default: typeof property.default === "string" ? property.default : undefined,
    };
  });
}

const formats: Record<string, { name: string; valid: (value: string) => boolean }> = {
  email: { name: "email address", valid: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) },
  uri: { name: "absolute URI", valid: (value) => URL.canParse(value) },
  date: {
    name: "date (YYYY-MM-DD)",
    valid: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
  },
  "date-time": {
    name: "date and time (RFC 3339)",
    valid: (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(value) && !Number.isNaN(Date.parse(value)),
  },
};

const textLimit = (field: Extract<Field, { type: "string" }>) => Math.min(field.maxLength ?? MAX_TEXT, MAX_TEXT);

/** Validate a value against its field; returns a user-facing problem or undefined. */
export function problem(field: Field, value: FormValue): string | undefined {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return "Enter text.";
      const length = [...value].length;
      if (length > textLimit(field)) return `Use at most ${textLimit(field)} characters.`;
      if (field.minLength !== undefined && length < field.minLength) return `Use at least ${field.minLength} characters.`;
      const format = field.format ? formats[field.format] : undefined;
      if (format && !format.valid(value)) return `Enter a valid ${format.name}.`;
      return;
    }
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
      if (field.type === "integer" && !Number.isInteger(value)) return "Enter a whole number.";
      if (field.minimum !== undefined && value < field.minimum) return `Enter at least ${field.minimum}.`;
      if (field.maximum !== undefined && value > field.maximum) return `Enter at most ${field.maximum}.`;
      return;
    case "boolean":
      return typeof value === "boolean" ? undefined : "Choose yes or no.";
    case "choice":
      return typeof value === "string" && field.options.some((option) => option.value === value) ? undefined : "Choose one of the listed options.";
    case "multi":
      if (!Array.isArray(value) || new Set(value).size !== value.length ||
          value.some((item) => !field.options.some((option) => option.value === item))) return "Choose from the listed options.";
      if (field.minItems !== undefined && value.length < field.minItems) return `Choose at least ${field.minItems}.`;
      if (field.maxItems !== undefined && value.length > field.maxItems) return `Choose at most ${field.maxItems}.`;
  }
}

const range = (min?: number, max?: number, unit = "") =>
  min !== undefined && max !== undefined ? `${min}–${max}${unit}` : min !== undefined ? `at least ${min}${unit}` : max !== undefined ? `at most ${max}${unit}` : "";

function constraints(field: Field): string {
  const parts: string[] = [];
  if (field.type === "string") {
    parts.push(field.format && formats[field.format] ? formats[field.format].name : "text");
    const length = range(field.minLength, field.maxLength, " characters");
    if (length) parts.push(length);
  } else if (field.type === "number" || field.type === "integer") {
    parts.push(field.type === "integer" ? "whole number" : "number");
    const bounds = range(field.minimum, field.maximum);
    if (bounds) parts.push(bounds);
  } else if (field.type === "boolean") parts.push("yes or no");
  else if (field.type === "choice") parts.push("choose one");
  else if (field.type === "multi") parts.push(`choose ${range(field.minItems, field.maxItems) || "any"}`);
  parts.push(field.required ? "required" : "optional");
  return parts.join(", ");
}

const label = (field: Field, value: string) =>
  field.type === "choice" || field.type === "multi" ? field.options.find((option) => option.value === value)?.label ?? value : value;

function shown(field: Field, value: FormValue | undefined): string {
  if (value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map((item) => label(field, item)).join(", ") || "none";
  if (typeof value === "number") return String(value);
  if (field.type === "choice") return label(field, value);
  const text = line(value);
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 59)}…` : text);
}

async function edit(ui: ElicitationUI, field: Field, values: Map<string, FormValue>, signal: AbortSignal): Promise<void> {
  const current = values.get(field.name);
  const title = `${field.label}\n${[constraints(field), field.description].filter(Boolean).join("\n")}`;
  const clear = field.required ? [] : ["Clear value"];
  if (field.type === "boolean" || field.type === "choice") {
    const options = field.type === "boolean"
      ? [{ value: true, label: "Yes" }, { value: false, label: "No" }]
      : field.options.map((option) => ({ value: option.value as FormValue, label: option.label }));
    const labels = options.map((option, index) => `${option.value === current ? "●" : "○"} ${index + 1}. ${option.label}`);
    const choice = await ui.select(title, [...labels, ...clear, "Back"], signal);
    if (choice === "Clear value") values.delete(field.name);
    else if (choice !== undefined && labels.includes(choice)) values.set(field.name, options[labels.indexOf(choice)].value);
    return;
  }
  if (field.type === "multi") {
    const selected = new Set(Array.isArray(current) ? current : []);
    while (!signal.aborted) {
      const labels = field.options.map((option, index) => `${selected.has(option.value) ? "☑" : "☐"} ${index + 1}. ${option.label}`);
      const choice = await ui.select(`${title}\nSelect options to toggle them, then choose Done.`, [...labels, "Done", ...clear, "Back"], signal);
      if (choice === undefined || choice === "Back") return;
      if (choice === "Clear value") return void values.delete(field.name);
      if (choice === "Done") {
        const value = field.options.map((option) => option.value).filter((value) => selected.has(value));
        const issue = problem(field, value);
        if (issue) ui.notify(`${field.label}: ${issue}`, "error");
        else return void values.set(field.name, value);
        continue;
      }
      const option = field.options[labels.indexOf(choice)];
      if (option && !selected.delete(option.value)) selected.add(option.value);
    }
    return;
  }
  const text = await ui.editor(`${title}${field.required ? "" : "\nLeave empty to clear the value."}`, current === undefined ? "" : String(current));
  if (text === undefined || signal.aborted) return;
  if (!text.trim() && !field.required && (field.type !== "string" || !text)) return void values.delete(field.name);
  const value = field.type === "string" ? text : text.trim() ? Number(text.trim()) : Number.NaN;
  const issue = problem(field, value);
  if (issue) ui.notify(`${field.label}: ${issue} The previous value was kept.`, "error");
  else values.set(field.name, value);
}

async function elicitForm(ui: ElicitationUI, server: string, params: ElicitRequestFormParams, signal: AbortSignal): Promise<ElicitResult> {
  const fields = formFields(params.requestedSchema);
  const values = new Map<string, FormValue>();
  for (const field of fields)
    if (field.default !== undefined && !problem(field, field.default)) values.set(field.name, field.default);
  const title = `${server} requests information\n${message(params.message)}\n\n` +
    `Review the values below. Only what you submit is sent to ${server}. Never enter passwords, API keys, or payment details here.`;
  while (!signal.aborted) {
    const labels = fields.map((field, index) =>
      `${index + 1}. ${field.label} (${field.required ? "required" : "optional"}) · ${shown(field, values.get(field.name))}`);
    const choice = await ui.select(title, [...labels, "Submit", "Decline", "Cancel"], signal);
    if (signal.aborted || choice === undefined || choice === "Cancel") break;
    if (choice === "Decline") return { action: "decline" };
    if (choice === "Submit") {
      const issue = fields.map((field) => {
        const value = values.get(field.name);
        if (value === undefined) return field.required ? `${field.label}: A value is required.` : undefined;
        const found = problem(field, value);
        return found && `${field.label}: ${found}`;
      }).find(Boolean);
      const content = Object.fromEntries(values);
      if (issue) ui.notify(issue, "error");
      else if (Buffer.byteLength(JSON.stringify(content)) > MAX_CONTENT) ui.notify("The submitted values exceed 64 KiB.", "error");
      else return { action: "accept", content };
      continue;
    }
    const field = fields[labels.indexOf(choice)];
    if (field) await edit(ui, field, values, signal);
  }
  return { action: "cancel" };
}

/** HTTPS, or HTTP on loopback, without embedded credentials. The opened URL is the displayed URL. */
export function safeUrl(value: string): { href: string; host: string; notes: string[] } | undefined {
  if (typeof value !== "string" || value.length > 4096 || !URL.canParse(value)) return;
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return;
  const notes: string[] = [];
  if (url.hostname.split(".").some((part) => part.startsWith("xn--")))
    notes.push("⚠ The site name contains internationalized characters. Check that it's the site you expect.");
  if (url.protocol === "http:") notes.push("⚠ This page uses an unencrypted connection to this computer.");
  return { href: url.href, host: url.host, notes };
}

async function elicitUrl(ui: ElicitationUI, server: string, params: ElicitRequestURLParams, signal: AbortSignal): Promise<ElicitResult> {
  const target = safeUrl(params.url);
  if (!target) {
    ui.notify(`${server} asked to open an unsupported URL, so the request was refused. Only HTTPS pages, or HTTP pages on this computer, without embedded credentials can be opened.`, "warning");
    throw invalid("Unsupported elicitation URL.");
  }
  let failed = false;
  while (!signal.aborted) {
    const choice = await ui.select(
      `${server} asks you to open a web page\n${message(params.message)}\n\n` +
      `Site: ${target.host}\nURL: ${target.href}\n${target.notes.map((note) => `${note}\n`).join("")}` +
      (failed ? "Couldn't open a browser. Copy the URL, then choose \"I'll open it myself\".\n" : "") +
      "Anything you enter on the page goes to that site, not to Pi. Copy the URL before choosing to open it elsewhere.",
      ["Open in browser", "I'll open it myself", "Decline"], signal);
    if (signal.aborted || choice === undefined) break;
    if (choice === "Decline") return { action: "decline" };
    if (choice === "I'll open it myself") return { action: "accept" };
    if (await ui.open(target.href)) return { action: "accept" };
    failed = true;
  }
  return { action: "cancel" };
}

/** Present one server request. Returned results never include unrequested fields. */
export function elicit(ui: ElicitationUI, server: string, params: ElicitRequestParams, signal: AbortSignal): Promise<ElicitResult> {
  const name = line(server);
  return params.mode === "url"
    ? elicitUrl(ui, name, params, signal)
    : elicitForm(ui, name, params as ElicitRequestFormParams, signal);
}

/** Manual controls for a required browser step; closes early on the server's completion notice. */
export async function awaitCompletion(ui: ElicitationUI, server: string, completed: AbortSignal, signal: AbortSignal): Promise<boolean> {
  const name = line(server);
  const choice = await ui.select(
    `${name} · Finish in your browser\nComplete the step on the page you opened, then choose Done. ` +
    `This closes automatically if ${name} confirms completion. The tool runs again only if the assistant calls it.`,
    ["Done", "Cancel"], AbortSignal.any([completed, signal]));
  return completed.aborted || (choice === "Done" && !signal.aborted);
}

/** Validated URL elicitations from a -32042 error, or undefined for other errors or unusable data. */
export function requiredElicitations(error: unknown): ElicitRequestURLParams[] | undefined {
  if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.UrlElicitationRequired) return;
  const list = (error.data as { elicitations?: unknown } | undefined)?.elicitations;
  if (!Array.isArray(list) || !list.length || list.length > MAX_REQUIRED) return;
  const valid = list.every((item) => typeof item === "object" && item !== null && item.mode === "url" &&
    typeof item.message === "string" && typeof item.url === "string" &&
    typeof item.elicitationId === "string" && item.elicitationId.length > 0 && item.elicitationId.length <= 256);
  if (!valid || new Set(list.map((item) => item.elicitationId)).size !== list.length) return;
  return list.map(({ mode, message, url, elicitationId }) => ({ mode, message, url, elicitationId }));
}
