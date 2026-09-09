import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { McpRuntime, type ConnectFactory } from "../src/runtime.js";
import { validCompletion } from "../src/resources.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(protocol: "auto" | "legacy" = "auto", supported = true) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-interactions-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const servers: McpServer[] = [];
  const clients: Client[] = [];
  const updates: string[] = [];
  let reads = 0, completes = 0, subscribes = 0, unsubscribes = 0;
  let completionContext: unknown;
  const connect: ConnectFactory = async () => {
    const server = new McpServer({ name: "test", version: "1" }, {
      capabilities: { resources: { subscribe: supported } },
    });
    server.registerResource("records", new ResourceTemplate("record://{table}/{id}", {
      list: undefined,
      complete: supported ? { id: async (value, context) => {
        completes++;
        completionContext = context;
        return [`${value}1`, `${value}2`];
      } } : undefined,
    }), {}, async (uri) => { reads++; return { contents: [{ uri: uri.href, text: "snapshot" }] }; });
    server.server.setRequestHandler("resources/subscribe", async () => { subscribes++; return {}; });
    server.server.setRequestHandler("resources/unsubscribe", async () => { unsubscribes++; return {}; });
    const [transport, other] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => server, { transport: other });
    cleanup.push(() => handle.close());
    const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: protocol } });
    await client.connect(transport);
    clients.push(client); servers.push(server);
    cleanup.push(() => server.close());
    return { client, transport };
  };
  const runtime = new McpRuntime({ example: { command: "fixture", timeoutMs: 1000 }, other: { command: "fixture", timeoutMs: 1000 } }, directory, join(directory, "cache"), connect);
  runtime.onResourceUpdated = (server, uri) => updates.push(`${server}:${uri}`);
  cleanup.push(() => runtime.close());
  return { runtime, clients, servers, updates, counts: () => ({ reads, completes, subscribes, unsubscribes }), context: () => completionContext };
}
const target = { server: "example", template: "record://{table}/{id}", argument: { name: "id", value: "a" }, arguments: { table: "events" } };
async function settle() { await Bun.sleep(20); }

for (const protocol of ["auto", "legacy"] as const) {
  test(`${protocol}: completions pass known context without reading or activating`, async () => {
    const f = await fixture(protocol);
    const result = await f.runtime.completeResource(target);
    expect(result.values).toEqual(["a1", "a2"]);
    expect(f.context()).toEqual({ arguments: { table: "events" } });
    expect(f.counts()).toMatchObject({ reads: 0, completes: 1, subscribes: 0 });
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
    await expect(f.runtime.completeResource({ ...target, template: "missing://{id}" })).rejects.toThrow("resource_not_found");
    await expect(f.runtime.completeResource({ ...target, argument: { name: "unknown", value: "" } })).rejects.toThrow("completion_invalid");
    expect(f.counts().completes).toBe(1);
  });

  test(`${protocol}: explicit watches coalesce updates, route by server, and never read`, async () => {
    const f = await fixture(protocol);
    await Promise.all([
      f.runtime.setResourceSubscription("example", "record://events/1", true),
      f.runtime.setResourceSubscription("example", "record://events/1", true),
    ]);
    await f.runtime.setResourceSubscription("other", "record://events/1", true);
    expect(f.runtime.resourceSubscriptions()).toHaveLength(2);
    await f.servers[0].server.sendResourceUpdated({ uri: "record://unwatched/1" });
    await f.servers[0].server.sendResourceUpdated({ uri: "record://events/1" });
    await f.servers[0].server.sendResourceUpdated({ uri: "record://events/1" });
    await settle();
    expect(f.updates).toEqual(["example:record://events/1"]);
    expect(f.runtime.resourceSubscriptions()).toEqual([
      { server: "example", uri: "record://events/1", changed: true },
      { server: "other", uri: "record://events/1", changed: false },
    ]);
    expect(f.counts().reads).toBe(0);
    await f.runtime.setResourceSubscription("example", "record://events/1", false);
    await f.servers[0].server.sendResourceUpdated({ uri: "record://events/1" });
    await settle();
    expect(f.updates).toHaveLength(1);
    await f.runtime.clearResourceSubscriptions();
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
    if (protocol === "legacy") expect(f.counts()).toMatchObject({ subscribes: 2, unsubscribes: 2 });
    else expect(f.counts().subscribes).toBe(0);
  });

  test(`${protocol}: connection loss drops watches without resubscribing`, async () => {
    const f = await fixture(protocol);
    await f.runtime.setResourceSubscription("example", "record://events/1", true);
    await f.clients[0].close();
    await settle();
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
    await f.runtime.completeResource(target);
    expect(f.clients).toHaveLength(2);
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
  });
}

test("completion validation rejects malformed inputs before connecting", async () => {
  const f = await fixture();
  for (const value of [null, { ...target, read: {} }, { ...target, arguments: { table: [] } },
    { ...target, argument: { name: "id", value: 1 } }, { ...target, argument: { name: "id", value: "", extra: true } },
    { ...target, template: "record://bad\n{id}" }, { ...target, arguments: { table: "x".repeat(4097) } }]) {
    expect(validCompletion(value)).toBe(false);
    await expect(f.runtime.completeResource(value as any)).rejects.toThrow("completion_invalid");
  }
  expect(validCompletion({ ...target, argument: { name: "id", value: "" } })).toBe(true);
  expect(f.clients).toHaveLength(0);
});

test("unsupported capabilities fail without a read or subscription", async () => {
  const f = await fixture("legacy", false);
  await expect(f.runtime.completeResource(target)).rejects.toThrow("completions_unsupported");
  await expect(f.runtime.setResourceSubscription("example", "record://events/1", true)).rejects.toThrow("subscriptions_unsupported");
  expect(f.counts()).toMatchObject({ completes: 0, reads: 0, subscribes: 0 });
});

test("unsubscribing unknown watches and invalid URIs never connect", async () => {
  const f = await fixture();
  await f.runtime.setResourceSubscription("example", "record://events/1", false);
  await expect(f.runtime.setResourceSubscription("example", "/etc/passwd", true)).rejects.toThrow("resource_invalid");
  expect(f.clients).toHaveLength(0);
});

test("cancellation and branch cleanup prevent pending watches from surviving", async () => {
  const f = await fixture("legacy");
  await f.runtime.completeResource(target);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  f.servers[0].server.setRequestHandler("resources/subscribe", async (_request, ctx) => {
    started();
    await new Promise<void>((resolve) => ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true }));
    return {};
  });
  const operation = f.runtime.setResourceSubscription("example", "record://events/1", true);
  const rejected = expect(operation).rejects.toThrow();
  await ready;
  await f.runtime.clearResourceSubscriptions();
  await rejected;
  expect(f.runtime.resourceSubscriptions()).toEqual([]);
});

test("watch count is bounded and failures do not leave phantom subscriptions", async () => {
  const f = await fixture("legacy");
  for (let i = 0; i < 50; i++) await f.runtime.setResourceSubscription("example", `record://events/${i}`, true);
  await expect(f.runtime.setResourceSubscription("example", "record://events/50", true)).rejects.toThrow("subscription_limit");
  await f.runtime.setResourceSubscription("example", "record://events/0", false);
  const subscribe = spyOn(f.clients[0], "subscribeResource").mockRejectedValue(new Error("refused"));
  await expect(f.runtime.setResourceSubscription("example", "record://events/50", true)).rejects.toThrow("refused");
  expect(f.runtime.resourceSubscriptions()).toHaveLength(49);
  subscribe.mockRestore();
});

test("modern rejected filters close the stream and never claim a watch", async () => {
  const f = await fixture();
  await f.runtime.completeResource(target);
  let closed = false;
  const listen = spyOn(f.clients[0], "listen").mockResolvedValue({
    honoredFilter: {},
    close: async () => { closed = true; },
    closed: Promise.resolve("local"),
  });
  try {
    await expect(f.runtime.setResourceSubscription("example", "record://events/1", true)).rejects.toThrow("subscriptions_unsupported");
    expect(closed).toBe(true);
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
  } finally { listen.mockRestore(); }
});

test("completed modern watches outlive command cancellation, but not stream closure", async () => {
  const f = await fixture();
  await f.runtime.completeResource(target);
  const listen = spyOn(f.clients[0], "listen");
  try {
    const controller = new AbortController();
    await f.runtime.setResourceSubscription("example", "record://events/1", true, controller.signal);
    controller.abort();
    await f.servers[0].server.sendResourceUpdated({ uri: "record://events/1" });
    await settle();
    expect(f.updates).toEqual(["example:record://events/1"]);
    const stream = await listen.mock.results[0].value as Awaited<ReturnType<Client["listen"]>>;
    await stream.close();
    await settle();
    expect(f.runtime.resourceSubscriptions()).toEqual([]);
  } finally { listen.mockRestore(); }
});

test("completion failures, aborted calls, and unknown servers do not trigger reads", async () => {
  const f = await fixture();
  await expect(f.runtime.completeResource({ ...target, server: "unknown" })).rejects.toThrow("server_unknown");
  await expect(f.runtime.completeResource(target, AbortSignal.abort())).rejects.toThrow();
  await expect(f.runtime.setResourceSubscription("example", "record://events/1", true, AbortSignal.abort())).rejects.toThrow();
  expect(f.clients).toHaveLength(0);
  await f.runtime.completeResource(target);
  const complete = spyOn(f.clients[0], "complete").mockRejectedValue(new Error("failed"));
  try {
    await expect(f.runtime.completeResource(target)).rejects.toThrow("failed");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(f.counts().reads).toBe(0);
  } finally { complete.mockRestore(); }
});

test("new branch watches wait for old legacy unsubscriptions", async () => {
  const f = await fixture("legacy");
  await f.runtime.setResourceSubscription("example", "record://events/1", true);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const unsubscribe = spyOn(f.clients[0], "unsubscribeResource").mockImplementation(async () => { await gate; return {}; });
  const subscribe = spyOn(f.clients[0], "subscribeResource");
  try {
    const clearing = f.runtime.clearResourceSubscriptions();
    const adding = f.runtime.setResourceSubscription("example", "record://events/1", true);
    await settle();
    expect(subscribe).not.toHaveBeenCalled();
    release();
    await clearing;
    await adding;
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(f.runtime.resourceSubscriptions()).toHaveLength(1);
  } finally { release(); unsubscribe.mockRestore(); subscribe.mockRestore(); }
});
