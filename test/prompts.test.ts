import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport, type GetPromptResult } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { McpRuntime, type ConnectFactory } from "../src/runtime.js";
import { preparePrompt, preparePromptSnapshot, promptCommand, validPromptArguments, type PromptSnapshot } from "../src/prompts.js";
import { parsePromptCommand, runPromptCommand } from "../src/prompt-command.js";
import { searchCapabilities } from "../src/resources.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const descriptor = { name: "explain", description: "Explain an authentication topic", arguments: [
  { name: "topic", required: true, description: "Topic to explain" }, { name: "audience" },
] };
const prompt = preparePrompt("docs", "identity", descriptor);
const textResult = (text: string): GetPromptResult => ({ messages: [{ role: "user", content: { type: "text", text } }] });

async function fixture(protocol: "auto" | "legacy" = "auto") {
  const directory = await mkdtemp(join(tmpdir(), "mcp-prompts-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let gets = 0;
  let changed = 0;
  const servers: McpServer[] = [];
  const clients: Client[] = [];
  const notifications: (() => void)[] = [];
  const connect: ConnectFactory = async (_name, _config, _signal, _tools, _resources, onPromptsChanged) => {
    const server = new McpServer({ name: "prompts", version: "1" });
    server.registerTool("noop", { inputSchema: z.object({}) }, async () => ({ content: [] }));
    server.registerPrompt("explain", {
      description: descriptor.description,
      argsSchema: z.object({ topic: z.string().describe("Topic to explain"), audience: z.string().optional() }),
    }, ({ topic, audience }) => {
      gets++;
      return textResult(`Explain ${topic} for ${audience ?? "everyone"}.`);
    });
    const [transport, other] = InMemoryTransport.createLinkedPair();
    await server.connect(other);
    const notify = () => { changed++; onPromptsChanged?.(); };
    notifications.push(notify);
    const client = new Client({ name: "test", version: "1" }, {
      versionNegotiation: { mode: protocol },
      listChanged: { prompts: { autoRefresh: false, debounceMs: 0, onChanged: notify } },
    });
    await client.connect(transport);
    servers.push(server);
    clients.push(client);
    cleanup.push(() => server.close());
    return { client, transport };
  };
  const runtime = new McpRuntime({ docs: { command: "fixture", protocol } }, directory, join(directory, "cache"), connect);
  cleanup.push(() => runtime.close());
  return { runtime, directory, servers, clients, notifications, gets: () => gets, changed: () => changed };
}

for (const protocol of ["auto", "legacy"] as const) {
  test(`${protocol}: prompt discovery is metadata-only and notifications don't fetch bodies`, async () => {
    const f = await fixture(protocol);
    const discovery = await f.runtime.discover("docs", undefined, "prompts");
    expect(discovery.tools).toEqual([]);
    expect(discovery.resources).toEqual([]);
    expect(discovery.prompts?.[0].arguments.map((arg) => [arg.name, arg.required])).toEqual([["topic", true], ["audience", false]]);
    const candidates = searchCapabilities([], [], "authentication", "docs", 5, [], discovery.prompts);
    expect(candidates[0]).toMatchObject({ kind: "prompt", command: "/mcp prompt docs explain" });
    expect(candidates[0]).not.toHaveProperty("nextCall");
    expect(f.gets()).toBe(0);
    expect(await readdir(f.directory)).toEqual([]);
    const listing = spyOn(f.clients[0], "listPrompts");
    cleanup.push(() => listing.mockRestore());
    await f.runtime.promptCatalog("docs");
    expect(listing).not.toHaveBeenCalled();
    const before = f.changed();
    f.servers[0].registerPrompt("new", { description: "New prompt" }, () => textResult("new"));
    for (let i = 0; i < 100 && f.changed() === before; i++) await Bun.sleep(5);
    expect(f.changed()).toBeGreaterThan(before);
    expect(listing).not.toHaveBeenCalled();
    expect(f.gets()).toBe(0);
    expect((await f.runtime.promptCatalog("docs")).map((p) => p.name)).toContain("new");
    expect(listing).toHaveBeenCalledTimes(1);
    const result = await f.runtime.getPrompt("docs", "explain", { topic: "OAuth" });
    expect(result.messages[0].content).toEqual({ type: "text", text: "Explain OAuth for everyone." });
    await f.runtime.getPrompt("docs", "explain", { topic: "OAuth" });
    expect(f.gets()).toBe(2);
  });
}

test("SDK aggregates prompt pages and refresh invalidates only metadata", async () => {
  const f = await fixture("legacy");
  await f.runtime.promptCatalog("docs");
  const cursors: unknown[] = [];
  f.servers[0].server.setRequestHandler("prompts/list", async ({ params }) => {
    cursors.push(params?.cursor);
    return { prompts: [{ name: params?.cursor ? "second" : "first" }], ...(params?.cursor ? {} : { nextCursor: "next" }) };
  });
  expect((await f.runtime.promptCatalog("docs", undefined, true)).map((p) => p.name)).toEqual(["first", "second"]);
  expect(cursors).toEqual([undefined, "next"]);
  expect(f.gets()).toBe(0);
});

test("prompt catalog retries when invalidated during listing and refuses duplicates", async () => {
  const f = await fixture();
  await f.runtime.promptCatalog("docs");
  let count = 0;
  const listing = spyOn(f.clients[0], "listPrompts").mockImplementation(async () => {
    if (count++ === 0) f.notifications[0]();
    return { prompts: [{ name: count === 1 ? "stale" : "current" }] };
  });
  cleanup.push(() => listing.mockRestore());
  expect((await f.runtime.promptCatalog("docs", undefined, true))[0].name).toBe("current");
  listing.mockResolvedValue({ prompts: [{ name: "duplicate" }, { name: "duplicate" }] });
  await expect(f.runtime.promptCatalog("docs", undefined, true)).rejects.toThrow("protocol");
});

test("get validates exact names, argument presence and limits before fetching", async () => {
  const f = await fixture();
  await expect(f.runtime.getPrompt("docs", "missing", {})).rejects.toThrow("prompt");
  await expect(f.runtime.getPrompt("docs", "explain", {})).rejects.toThrow("arguments");
  await expect(f.runtime.getPrompt("docs", "explain", { topic: "x", invented: "x" })).rejects.toThrow("arguments");
  await expect(f.runtime.getPrompt("docs", "explain", { topic: "x".repeat(4097) })).rejects.toThrow("arguments");
  expect(f.gets()).toBe(0);
  const aborted = AbortSignal.abort();
  await expect(f.runtime.getPrompt("docs", "explain", { topic: "x" }, aborted)).rejects.toThrow();
  expect(f.gets()).toBe(0);
  await f.runtime.close();
  await expect(f.runtime.promptCatalog("docs")).rejects.toThrow();
});

test("descriptors and command quoting preserve exact identifiers without shell evaluation", () => {
  expect(() => preparePrompt("docs", "id", { name: "bad\u001b[31m" })).toThrow();
  expect(() => preparePrompt("docs", "id", { name: "x", arguments: [{ name: "x" }, { name: "x" }] })).toThrow();
  const name = 'review "my code" \\ now';
  const command = promptCommand({ server: "docs", name });
  expect(parsePromptCommand(command.slice(5)).name).toBe(name);
  expect(parsePromptCommand('prompt docs explain topic="OAuth flows" audience="$(touch nope)"').args)
    .toEqual({ topic: "OAuth flows", audience: "$(touch nope)" });
  expect(() => parsePromptCommand("prompt docs explain topic=x topic=y")).toThrow();
  expect(parsePromptCommand("prompt docs")).toEqual({ server: "docs", name: undefined, args: {} });
  expect(() => parsePromptCommand("prompt")).toThrow();
  expect(() => parsePromptCommand("prompts docs")).toThrow();
  expect(() => parsePromptCommand("prompts docs extra")).toThrow();
  expect(validPromptArguments(prompt, { topic: "" })).toBe(true);
  expect(validPromptArguments(prompt, {})).toBe(false);
});

test("snapshots label roles as data, sanitize terminal escapes, and never follow resources", () => {
  const snapshot = preparePromptSnapshot({ messages: [
    { role: "user", content: { type: "text", text: "Read https://example.com\n\u001b[31mText" } },
    { role: "assistant", content: { type: "resource", resource: { uri: "file:///private", text: "Embedded only" } } },
  ] }, "docs");
  expect(snapshot.count).toBe(2);
  expect(snapshot.usable).toBe(true);
  expect(snapshot.body).not.toContain("\u001b");
  expect(snapshot.preview).toContain("assistant (server supplied)");
  expect(JSON.parse(snapshot.body).messages[1].content.text).toBe("Embedded only");
  const unsupported = preparePromptSnapshot({ messages: [{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } }] }, "docs");
  expect(unsupported.usable).toBe(false);
  expect(unsupported.preview).toContain("Unsupported image");
  expect(unsupported.preview).not.toContain("AAAA");
  expect(() => preparePromptSnapshot(textResult("x".repeat(51 * 1024)), "docs")).toThrow("50 KiB");
  expect(() => preparePromptSnapshot(textResult("x\n".repeat(2001)), "docs")).toThrow("2000 lines");
});

function commandHost(choices: (string | undefined | ((options: string[]) => string | undefined))[], result = textResult("Reviewed content")) {
  let gets = 0;
  const used: PromptSnapshot[] = [];
  const titles: string[] = [];
  const notifications: string[] = [];
  const ctx = {
    hasUI: true, mode: "rpc", isIdle: () => true,
    ui: {
      select: async (title: string, options: string[]) => {
        titles.push(title);
        if (!choices.length) throw new Error("Unexpected dialog");
        const choice = choices.shift();
        return typeof choice === "function" ? choice(options) : choice;
      },
      editor: async () => "OAuth",
      notify: (text: string) => notifications.push(text),
    },
  } as unknown as ExtensionCommandContext;
  const runtime = {
    promptCatalog: async () => [prompt],
    getPrompt: async () => { gets++; return result; },
  } as unknown as McpRuntime;
  const run = (input = "prompt docs explain topic=OAuth", guard = () => {}, signal = new AbortController().signal) =>
    runPromptCommand(input, ctx, runtime, signal, guard, (_prompt, snapshot) => used.push(snapshot));
  return { ctx, runtime, run, used, gets: () => gets, titles, notifications };
}

test("browse and argument cancellation never fetch or attach content", async () => {
  const browse = commandHost([undefined]);
  await browse.run("prompt docs");
  expect(browse.titles[0]).toContain("Prompts (metadata only");
  expect(browse.gets()).toBe(0);
  expect(browse.used).toEqual([]);
  const args = commandHost(["Cancel"]);
  await args.run();
  expect(args.gets()).toBe(0);
  expect(args.used).toEqual([]);
});

test("preview cancellation fetches once but never starts a turn", async () => {
  const h = commandHost(["Fetch preview", "Cancel"]);
  await h.run();
  expect(h.gets()).toBe(1);
  expect(h.used).toEqual([]);
  expect(h.titles.at(-1)).toContain("Server-provided content");
});

test("explicit Use sends exactly the reviewed snapshot without refetching", async () => {
  const h = commandHost(["Fetch preview", "Use prompt"]);
  await h.run();
  expect(h.gets()).toBe(1);
  expect(h.used).toHaveLength(1);
  expect(h.used[0].body).toContain("Reviewed content");
});

test("required arguments aren't invented and optional arguments can remain omitted", async () => {
  const h = commandHost(["Fetch preview", (options) => options[0], "Edit value", "Fetch preview", "Use prompt"]);
  await h.run("prompt docs explain");
  expect(h.notifications[0]).toContain("required");
  expect(h.gets()).toBe(1);
  expect(h.used).toHaveLength(1);
});

test("unsupported blocks cannot be accepted as a partial prompt", async () => {
  const h = commandHost(["Fetch preview", (options) => {
    expect(options).not.toContain("Use prompt");
    return "Cancel";
  }], { messages: [{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } }] });
  await h.run();
  expect(h.used).toEqual([]);
});

test("headless, busy, aborted and stale sessions cannot use a prompt", async () => {
  const headless = commandHost([]);
  Object.assign(headless.ctx, { hasUI: false });
  await expect(headless.run()).rejects.toThrow("interactive");
  expect(headless.gets()).toBe(0);
  const busy = commandHost(["Fetch preview", "Use prompt"]);
  busy.ctx.isIdle = () => false;
  await expect(busy.run()).rejects.toThrow("busy");
  expect(busy.used).toEqual([]);
  const stale = commandHost(["Fetch preview", "Use prompt"]);
  await expect(stale.run(undefined, () => { if (stale.gets()) throw new Error("session changed"); })).rejects.toThrow("session changed");
  expect(stale.used).toEqual([]);
  const aborted = commandHost([]);
  await expect(aborted.run(undefined, () => {}, AbortSignal.abort())).rejects.toThrow();
  expect(aborted.gets()).toBe(0);
});

test("catalog failures preserve healthy tool results and never replay failed gets", async () => {
  const f = await fixture();
  await f.runtime.promptCatalog("docs");
  const listing = spyOn(f.clients[0], "listPrompts").mockRejectedValue(new Error("private server detail"));
  cleanup.push(() => listing.mockRestore());
  f.notifications[0]();
  const discovery = await f.runtime.discover("docs", undefined, "all");
  expect(discovery.tools.map((tool) => tool.name)).toContain("noop");
  expect(discovery.prompts).toEqual([]);
  expect(discovery.unavailable.join(" ")).not.toContain("private server detail");
  listing.mockRestore();
  const get = spyOn(f.clients[0], "getPrompt").mockRejectedValue(new Error("private prompt payload"));
  cleanup.push(() => get.mockRestore());
  let error: unknown;
  try { await f.runtime.getPrompt("docs", "explain", { topic: "OAuth" }); }
  catch (caught) { error = caught; }
  expect(String(error)).not.toContain("private prompt payload");
  expect(get).toHaveBeenCalledTimes(1);
});

test("disconnect discards prompt metadata and stale notification callbacks", async () => {
  const f = await fixture();
  await f.runtime.promptCatalog("docs");
  await f.runtime.disconnect(["docs"]);
  await f.runtime.promptCatalog("docs");
  expect(f.clients).toHaveLength(2);
  const listing = spyOn(f.clients[1], "listPrompts");
  cleanup.push(() => listing.mockRestore());
  f.notifications[0]();
  await f.runtime.promptCatalog("docs");
  expect(listing).not.toHaveBeenCalled();
  expect(f.gets()).toBe(0);
});

test("long previews are paginated and Back requires an explicit new fetch", async () => {
  const h = commandHost(["Fetch preview", "Next page", "Back", "Fetch preview", "Next page", "Use prompt"], textResult("line\n".repeat(20) + "Last page sentinel"));
  await h.run();
  expect(h.gets()).toBe(2);
  expect(h.titles.some((title) => title.includes("Last page sentinel"))).toBe(true);
  expect(h.used).toHaveLength(1);
  expect(h.used[0].body).toContain("Last page sentinel");
});
