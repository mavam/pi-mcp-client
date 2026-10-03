import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { ActivatedMcpTools, createMcpExtension } from "../src/durable.js";
import type { ConnectFactory } from "../src/runtime.js";

const context = BACKGROUND_CONTEXT;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-durable-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  let gate: Promise<void> | undefined;
  let release = () => {};
  const connect: ConnectFactory = async () => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool("echo", { description: "Echo", inputSchema: z.object({ message: z.string() }) }, async ({ message }) => {
      calls++;
      await gate;
      return { content: [{ type: "text", text: message }] };
    });
    server.registerTool("ping", { description: "Ping", inputSchema: z.object({}) }, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    cleanup.push(() => server.close());
    return { client, transport: clientTransport };
  };
  const open = async () => {
    const registry = createRegistry();
    const mcp = await createMcpExtension({ registry, cwd: directory, agentDir: directory,
      config: { fixture: { command: "fixture" } }, connect });
    registry.install(mcp.extension);
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    const harness = await Harness.open(await openNodeJsonlStorage(join(directory, "session"), context), { models, registry }, context);
    cleanup.push(() => mcp.close());
    cleanup.push(() => harness.close(context));
    await mcp.restore(harness, context);
    const root = await harness.root(context, { agent: { cwd: directory,
      model: { provider: "faux", modelId: "faux-1" }, tools: mcp.extension.tools } });
    return { registry, mcp, harness, root, faux };
  };
  return { directory, open, calls: () => calls,
    block: () => { gate = new Promise<void>((resolve) => { release = resolve; }); },
    unblock: () => { release(); gate = undefined; },
  };
}

test("discovery is passive; activation is durable and scoped to one conversation", async () => {
  const fixtureValue = await fixture();
  const { root, faux, harness, mcp, registry } = await fixtureValue.open();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp_tools", { query: "echo" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Found."),
  ]);
  expect((await (await root.submit({ type: "input", content: "Find echo." }, context)).wait(context)).status).toBe("done");
  expect((await root.agent(context)).tools.map((tool) => tool.name)).toEqual(["mcp_tools"]);
  expect(fixtureValue.calls()).toBe(0);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp_tools", { activate: ["fixture.echo"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { message: "hello" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  expect((await (await root.submit({ type: "input", content: "Activate and call." }, context)).wait(context)).status).toBe("done");
  expect(fixtureValue.calls()).toBe(1);
  expect((await root.agent(context)).tools.map((tool) => tool.name)).toContain("mcp__fixture__echo");
  expect(Object.keys((await harness.snapshot(ActivatedMcpTools, root.id, context))!.tools)).toEqual(["mcp__fixture__echo"]);
  const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { tools: mcp.extension.tools } }, context);
  expect((await other.agent(context)).tools.map((tool) => tool.name)).toEqual(["mcp_tools"]);
  const native = registry.snapshot().tools().find((item) => item.tool.name === "mcp__fixture__echo")!.tool;
  expect(native.replay).toBe("unsafe");
  // Even an over-broad host loadout cannot bypass conversation-local activation.
  await other.configure({ cwd: fixtureValue.directory, model: { provider: "faux", modelId: "faux-1" }, tools: [native] }, context);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { message: "not authorized" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Refused."),
  ]);
  expect((await (await other.submit({ type: "input", content: "Call without activation." }, context)).wait(context)).status).toBe("done");
  expect(fixtureValue.calls()).toBe(1);
});

test("reopening storage restores native tool code before continuing", async () => {
  const fixtureValue = await fixture();
  const first = await fixtureValue.open();
  first.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp_tools", { activate: ["fixture.echo"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Activated."),
  ]);
  expect((await (await first.root.submit({ type: "input", content: "Activate." }, context)).wait(context)).status).toBe("done");
  await first.harness.close(context);
  await first.mcp.close();
  const reopened = await fixtureValue.open();
  const restored = (await reopened.root.agent(context)).tools;
  expect(restored.map((tool: ToolRegistration) => tool.name)).toContain("mcp__fixture__echo");
  reopened.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { message: "after restart" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  expect((await (await reopened.root.submit({ type: "input", content: "Call again." }, context)).wait(context)).status).toBe("done");
  expect(fixtureValue.calls()).toBe(1);
});

test("an interrupted external call is reported after restart, never invoked a second time", async () => {
  const fixtureValue = await fixture();
  const first = await fixtureValue.open();
  first.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp_tools", { activate: ["fixture.echo"] }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Activated."),
  ]);
  await (await first.root.submit({ type: "input", content: "Activate." }, context)).wait(context);
  fixtureValue.block();
  first.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", { message: "side effect already happened" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const input = { type: "input", content: "Call.", requestId: "interrupted-call" } as const;
  await first.root.submit(input, context);
  for (let attempt = 0; attempt < 100 && fixtureValue.calls() === 0; attempt++) await Bun.sleep(10);
  expect(fixtureValue.calls()).toBe(1);
  await first.harness.close(context);
  fixtureValue.unblock();
  await first.mcp.close();
  const reopened = await fixtureValue.open();
  reopened.faux.setResponses([fauxAssistantMessage("The external call was interrupted; verify before retrying.")]);
  expect((await (await reopened.root.submit(input, context)).wait(context)).status).toBe("done");
  expect(fixtureValue.calls()).toBe(1);
  const entries = await reopened.root.entries({}, 50, undefined, context);
  expect(entries.items.some((entry) => entry.model?.some((message) => message.role === "toolResult" &&
    message.toolName === "mcp__fixture__echo" && message.isError))).toBe(true);
}, 10000);

test("parallel activations union against committed selection without losing a sibling", async () => {
  const fixtureValue = await fixture();
  const { root, faux, harness } = await fixtureValue.open();
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("mcp_tools", { activate: ["fixture.echo"] }),
      fauxToolCall("mcp_tools", { activate: ["fixture.ping"] }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Both activated."),
  ]);
  expect((await (await root.submit({ type: "input", content: "Activate both in parallel." }, context)).wait(context)).status).toBe("done");
  expect(Object.keys((await harness.snapshot(ActivatedMcpTools, root.id, context))!.tools).sort()).toEqual(["mcp__fixture__echo", "mcp__fixture__ping"]);
  expect((await root.agent(context)).tools.map((tool) => tool.name).sort()).toEqual(["mcp__fixture__echo", "mcp__fixture__ping", "mcp_tools"]);
  expect(fixtureValue.calls()).toBe(0);
});
