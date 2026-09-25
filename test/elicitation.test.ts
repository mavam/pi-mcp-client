import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import {
  McpServer,
  UrlElicitationRequiredError,
  acceptedContent,
  createMcpHandler,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import packageJson from "../package.json" with { type: "json" };
import { elicit, formFields, problem, requiredElicitations, safeUrl, type ElicitationUI } from "../src/elicitation.js";
import { DiagnosticError } from "../src/diagnostics.js";
import { McpRuntime, createClient, type ConnectFactory } from "../src/runtime.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Answer = string | ((title: string, choices: string[], signal: AbortSignal) => Promise<string | undefined> | string | undefined);

/** Scripted dialogs: string answers select the first choice with that prefix. */
function fakeUi(answers: Answer[], edits: (string | undefined)[] = [], opens: boolean[] = []) {
  const titles: string[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const ui: ElicitationUI = {
    select(title, choices, signal) {
      titles.push(title);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`Unexpected dialog: ${title}`);
      return new Promise((resolve) => {
        const abort = () => resolve(undefined);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(typeof answer === "string"
          ? choices.find((choice) => choice.startsWith(answer))
          : answer(title, choices, signal)).then((value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        });
      });
    },
    async editor() {
      return edits.shift();
    },
    notify(message) {
      notices.push(message);
    },
    async open(url) {
      opened.push(url);
      return opens.shift() ?? true;
    },
  };
  return { ui, titles, notices, opened, remaining: () => answers.length };
}

const never = (_title: string, _choices: string[], signal: AbortSignal) =>
  new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));

const signal = () => new AbortController().signal;

const contactForm = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const, title: "Full name", minLength: 2 },
    email: { type: "string" as const, format: "email" as const },
    age: { type: "integer" as const, minimum: 18, default: 30 },
    subscribe: { type: "boolean" as const, default: false },
    color: { type: "string" as const, oneOf: [{ const: "#f00", title: "Red" }, { const: "#0f0", title: "Green" }] },
    tags: { type: "array" as const, items: { type: "string" as const, enum: ["a", "b", "c"] }, maxItems: 2 },
  },
  required: ["name", "email"],
};

test("form schemas map to typed fields with bounded, sanitized labels", () => {
  const fields = formFields({
    ...contactForm,
    properties: {
      ...contactForm.properties,
      legacy: { type: "string", enum: ["x", "y"], enumNames: ["Ex\u001b[31m", "Why"] },
    },
  });
  expect(fields.map((field) => [field.name, field.type, field.required])).toEqual([
    ["name", "string", true], ["email", "string", true], ["age", "integer", false], ["subscribe", "boolean", false],
    ["color", "choice", false], ["tags", "multi", false], ["legacy", "choice", false],
  ]);
  expect(fields[0].label).toBe("Full name");
  const legacy = fields.at(-1)!;
  expect(legacy.type === "choice" && legacy.options.map((option) => option.label)).toEqual(["Ex", "Why"]);
  expect(() => formFields({ type: "object", properties: { pick: { type: "string", enum: ["a", "a"] } } })).toThrow("duplicated");
  expect(() => formFields({ type: "object", properties: Object.fromEntries(
    Array.from({ length: 51 }, (_, index) => [`f${index}`, { type: "string" as const }])) })).toThrow("50 fields");
});

test("values are validated against their field constraints", () => {
  const [name, email, age, subscribe, color, tags] = formFields(contactForm);
  expect(problem(name, "a")).toContain("at least 2");
  expect(problem(name, "ab")).toBeUndefined();
  expect(problem(email, "nope")).toContain("email");
  expect(problem(email, "pi@example.com")).toBeUndefined();
  expect(problem(age, 17)).toContain("at least 18");
  expect(problem(age, 18.5)).toContain("whole number");
  expect(problem(subscribe, "yes")).toBeDefined();
  expect(problem(color, "#00f")).toBeDefined();
  expect(problem(tags, ["a", "b", "c"])).toContain("at most 2");
  expect(problem(tags, ["a", "a"])).toBeDefined();
  const [date, stamp, uri] = formFields({ type: "object", properties: {
    date: { type: "string", format: "date" }, stamp: { type: "string", format: "date-time" }, uri: { type: "string", format: "uri" },
  } });
  expect(problem(date, "2026-02-30")).toBeDefined();
  expect(problem(date, "2026-02-28")).toBeUndefined();
  expect(problem(stamp, "2026-02-28T10:00:00Z")).toBeUndefined();
  expect(problem(stamp, "2026-02-28 10:00")).toBeDefined();
  expect(problem(uri, "https://example.com/x")).toBeUndefined();
  expect(problem(uri, "not a uri")).toBeDefined();
});

test("forms prefill defaults, require explicit review, and submit only reviewed values", async () => {
  const { ui, titles, notices } = fakeUi(
    ["Submit", "1. Full name", "2. email", "6. tags", "☐ 1. a", "☐ 3. c", "Done", "Submit"],
    ["Ada Lovelace", "ada@example.com"],
  );
  const result = await elicit(ui, "crm", { mode: "form", message: "Add a contact\u0007", requestedSchema: contactForm }, signal());
  expect(result).toEqual({ action: "accept", content: { age: 30, subscribe: false, name: "Ada Lovelace", email: "ada@example.com", tags: ["a", "c"] } });
  expect(notices).toEqual(["Full name: A value is required."]);
  expect(titles[0]).toStartWith("crm requests information\nAdd a contact\n");
  expect(titles[0]).toContain("Never enter passwords");
});

test("invalid edits keep the previous value, and decline and dismissal are distinct", async () => {
  const edited = fakeUi(["3. age", "Submit", "Decline"], ["12"]);
  expect(await elicit(edited.ui, "crm", { message: "Details", requestedSchema: contactForm }, signal())).toEqual({ action: "decline" });
  expect(edited.notices[0]).toBe("age: Enter at least 18. The previous value was kept.");
  const dismissed = fakeUi([() => undefined]);
  expect(await elicit(dismissed.ui, "crm", { message: "Details", requestedSchema: contactForm }, signal())).toEqual({ action: "cancel" });
});

test("URL requests require consent, show the exact target, and fall back to manual opening", async () => {
  const params = { mode: "url" as const, elicitationId: "e1", message: "Connect your account", url: "https://xn--80ak6aa92e.com/connect?id=e1" };
  const { ui, titles, opened } = fakeUi(["Open in browser", "I'll open it myself"], [], [false]);
  expect(await elicit(ui, "files", params, signal())).toEqual({ action: "accept" });
  expect(opened).toEqual(["https://xn--80ak6aa92e.com/connect?id=e1"]);
  expect(titles[0]).toContain("Site: xn--80ak6aa92e.com\nURL: https://xn--80ak6aa92e.com/connect?id=e1");
  expect(titles[0]).toContain("internationalized characters");
  expect(titles[1]).toContain("Couldn't open a browser");
  const declined = fakeUi(["Decline"]);
  expect(await elicit(declined.ui, "files", params, signal())).toEqual({ action: "decline" });
  expect(declined.opened).toEqual([]);
});

test("unsupported URLs are refused before any dialog", async () => {
  expect(safeUrl("https://example.com/a b")?.href).toBe("https://example.com/a%20b");
  expect(safeUrl("http://127.0.0.1:8080/cb")?.notes).toHaveLength(1);
  for (const url of ["http://example.com/", "https://user:pw@example.com/", "javascript:alert(1)", "file:///etc/passwd", "not a url"])
    expect(safeUrl(url)).toBeUndefined();
  const { ui, notices, remaining } = fakeUi(["Open in browser"]);
  await expect(elicit(ui, "files", { mode: "url", elicitationId: "e", message: "", url: "http://example.com/" }, signal()))
    .rejects.toThrow("Unsupported elicitation URL");
  expect(notices[0]).toContain("unsupported URL");
  expect(remaining()).toBe(1);
});

test("required URL elicitations are validated and bounded", () => {
  const item = { mode: "url", elicitationId: "a", message: "m", url: "https://example.com" };
  expect(requiredElicitations(new UrlElicitationRequiredError([item as never]))).toEqual([item as never]);
  expect(requiredElicitations(new ProtocolError(ProtocolErrorCode.UrlElicitationRequired, "x", { elicitations: [item, item] }))).toBeUndefined();
  expect(requiredElicitations(new ProtocolError(ProtocolErrorCode.UrlElicitationRequired, "x", {
    elicitations: ["a", "b", "c", "d"].map((elicitationId) => ({ ...item, elicitationId })) }))).toBeUndefined();
  expect(requiredElicitations(new ProtocolError(ProtocolErrorCode.InvalidParams, "x", { elicitations: [item] }))).toBeUndefined();
});

interface ServerProbe { capabilities?: unknown; calls: number; clientVersion?: string }

/** A tool that asks for a name through input_required; legacy connections use the SDK's push shim. */
function greeter(probe: ServerProbe, before?: () => Promise<void>) {
  const server = new McpServer({ name: "greeter", version: "1" });
  server.registerTool("greet", { inputSchema: z.object({}) }, async (_args, ctx) => {
    probe.calls++;
    const response = inputResponse(ctx.mcpReq.inputResponses, "who");
    const answer = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, "who");
    if (answer) return { content: [{ type: "text", text: `hello ${answer.name}` }] };
    if (response.kind === "elicit") return { content: [{ type: "text", text: `no answer: ${response.action}` }] };
    await before?.();
    return inputRequired({ inputRequests: { who: inputRequired.elicit({
      message: "Who are you?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }) } });
  });
  server.registerTool("connect", { inputSchema: z.object({}) }, async () => {
    probe.calls++;
    throw new UrlElicitationRequiredError([{ mode: "url", elicitationId: "grant-1", message: "Authorize access", url: "https://example.com/connect/grant-1" }]);
  });
  server.registerTool("overreach", { inputSchema: z.object({}) }, async () => {
    probe.calls++;
    throw new UrlElicitationRequiredError(["a", "b", "c", "d"].map((elicitationId) =>
      ({ mode: "url" as const, elicitationId, message: "Step", url: "https://example.com/step" })));
  });
  server.server.oninitialized = () => {
    probe.capabilities = server.server.getClientCapabilities();
    probe.clientVersion = server.server.getClientVersion()?.version;
  };
  return server;
}

async function inMemory(interactive: boolean, probe: ServerProbe, before?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-elicit-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const servers: McpServer[] = [];
  const connect: ConnectFactory = async (_name, config, _signal, handlers) => {
    const server = greeter(probe, before);
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = createClient(config, handlers);
    await client.connect(clientTransport);
    cleanup.push(() => server.close());
    return { client, transport: clientTransport };
  };
  const runtime = new McpRuntime({ example: { command: "fixture", toolTimeoutMs: 150 } }, directory, join(directory, "cache"), connect, { interactive });
  cleanup.push(() => runtime.close());
  const tools = await runtime.catalog("example");
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { runtime, tool, servers };
}

const nameForm = (value: string, delay = 0): Answer[] => ["1. name", async () => {
  await Bun.sleep(delay);
  return "Submit";
}];

test("interactive sessions declare elicitation and report the package version", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool } = await inMemory(true, probe);
  const { ui, titles, remaining } = fakeUi(nameForm("pi"), ["pi"]);
  const progress: string[] = [];
  const result = await runtime.call(tool("greet"), {}, undefined, (message) => progress.push(message), ui);
  expect(result.content).toEqual([{ type: "text", text: "hello pi" }]);
  expect(probe.capabilities).toMatchObject({ elicitation: { form: {}, url: {} } });
  expect(probe.clientVersion).toBe(packageJson.version);
  expect(titles[0]).toStartWith("example requests information\nWho are you?");
  expect(progress).toEqual(["Waiting for your input…", "Calling…"]);
  expect(remaining()).toBe(0);
});

test("answering doesn't count against the tool timeout", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool } = await inMemory(true, probe);
  const { ui } = fakeUi(nameForm("slow", 400), ["slow"]);
  const result = await runtime.call(tool("greet"), {}, undefined, undefined, ui);
  expect(result.content).toEqual([{ type: "text", text: "hello slow" }]);
});

test("time before a request still counts against the tool timeout", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool } = await inMemory(true, probe, () => Bun.sleep(300));
  const { ui, titles } = fakeUi(nameForm("late"), ["late"]);
  await expect(runtime.call(tool("greet"), {}, undefined, undefined, ui)).rejects.toThrow("[timeout]");
  expect(titles).toEqual([]);
});

test("headless sessions don't declare elicitation", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool } = await inMemory(false, probe);
  const { ui, titles } = fakeUi(nameForm("x"), ["x"]);
  const result = await runtime.call(tool("greet"), {}, undefined, undefined, ui);
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("did not declare the required capability");
  expect(probe.capabilities).not.toHaveProperty("elicitation");
  expect(titles).toEqual([]);
});

test("requests outside an interactive call are refused without a dialog", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool, servers } = await inMemory(true, probe);
  const result = await runtime.call(tool("greet"), {});
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("only accepted during an interactive tool call");
  await expect(servers[0].server.elicitInput({ message: "Unsolicited", requestedSchema: { type: "object", properties: {} } }))
    .rejects.toThrow("only accepted during an interactive tool call");
});

test("aborting the call closes an open request", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool } = await inMemory(true, probe);
  const abort = new AbortController();
  const opened = Promise.withResolvers<void>();
  const { ui } = fakeUi([(title, choices, signal) => {
    opened.resolve();
    return never(title, choices, signal);
  }]);
  const call = runtime.call(tool("greet"), {}, abort.signal, undefined, ui);
  await opened.promise;
  abort.abort(new Error("stop"));
  await expect(call).rejects.toThrow("[cancelled]");
});

test("required browser steps wait for completion and are never replayed", async () => {
  const probe: ServerProbe = { calls: 0 };
  const { runtime, tool, servers } = await inMemory(true, probe);
  const { ui, titles, opened } = fakeUi(["Open in browser", never]);
  const original = ui.open;
  ui.open = async (url) => {
    // The server confirms completion out of band; the waiting dialog closes itself.
    setTimeout(() => void servers[0].server.createElicitationCompletionNotifier("grant-1")(), 20);
    return original(url);
  };
  const error = await runtime.call(tool("connect"), {}, undefined, undefined, ui).catch((error) => error);
  expect(error).toBeInstanceOf(DiagnosticError);
  expect(error.diagnostic.code).toBe("elicitation_completed");
  expect(opened).toEqual(["https://example.com/connect/grant-1"]);
  expect(titles[1]).toStartWith("example · Finish in your browser");
  expect(probe.calls).toBe(1);
  expect(runtime.serverStatuses()[0].state).toBe("connected");

  const declined = fakeUi(["Decline"]);
  const refusal = await runtime.call(tool("connect"), {}, undefined, undefined, declined.ui).catch((error) => error);
  expect(refusal.diagnostic.code).toBe("elicitation_declined");
  const headless = await runtime.call(tool("connect"), {}).catch((error) => error);
  expect(headless.diagnostic.code).toBe("elicitation_required");
  expect(probe.calls).toBe(3);

  const abort = new AbortController();
  const interrupted = fakeUi([(title, choices, signal) => {
    abort.abort(new Error("stop"));
    return never(title, choices, signal);
  }]);
  const stopped = await runtime.call(tool("connect"), {}, abort.signal, undefined, interrupted.ui).catch((error) => error);
  expect(stopped.diagnostic.code).toBe("cancelled");
  // Unusable requirement data never reaches a dialog.
  const overreach = fakeUi([]);
  const rejected = await runtime.call(tool("overreach"), {}, undefined, undefined, overreach.ui).catch((error) => error);
  expect(rejected.diagnostic.code).toBe("protocol_error");
  expect(overreach.titles).toEqual([]);
});

test("2026-07-28 input_required rounds use the same dialogs over HTTP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-elicit-http-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const probe: ServerProbe = { calls: 0 };
  const mcp = createMcpHandler(() => greeter(probe));
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => mcp.fetch(req) });
  cleanup.push(async () => { await http.stop(true); });
  cleanup.push(() => mcp.close());
  const runtime = new McpRuntime({ example: { url: `http://127.0.0.1:${http.port}/mcp`, headers: { Authorization: "fixture" }, toolTimeoutMs: 150 } },
    directory, join(directory, "cache"), undefined, { interactive: true });
  cleanup.push(() => runtime.close());
  const [greet] = (await runtime.catalog("example")).filter((tool) => tool.name === "greet");
  const { ui } = fakeUi(nameForm("http", 300), ["http"]);
  const result = await runtime.call(greet, {}, undefined, undefined, ui);
  expect(result.content).toEqual([{ type: "text", text: "hello http" }]);
  const declined = fakeUi(["Decline"]);
  expect((await runtime.call(greet, {}, undefined, undefined, declined.ui)).content)
    .toEqual([{ type: "text", text: "no answer: decline" }]);
});
