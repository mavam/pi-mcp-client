import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { McpRuntime, waitFor, type ConnectFactory } from "../src/runtime.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let connects = 0;
  let calls = 0;
  const handles: ReturnType<McpServer["registerTool"]>[] = [];
  const connect: ConnectFactory = async () => {
    connects++;
    const server = new McpServer({ name: "fixture", version: "1" });
    handles.push(
      server.registerTool(
        "echo",
        {
          description: "Echo a message",
          inputSchema: z.object({ message: z.string() }),
        },
        async ({ message }) => {
          calls++;
          return { content: [{ type: "text", text: message }] };
        },
      ),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientTransport);
    cleanup.push(() => server.close());
    return { client, transport: clientTransport };
  };
  const runtime = new McpRuntime(
    { example: { command: "fixture" } },
    directory,
    join(directory, "cache"),
    connect,
  );
  cleanup.push(() => runtime.close());
  return {
    runtime,
    connect,
    directory,
    handles,
    connects: () => connects,
    calls: () => calls,
  };
}

test("secret commands run only once per shared connection and rerun on reconnect", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "token"), "first-secret");
  const config = {
    example: {
      url: "https://example.com/mcp",
      headers: { Authorization: "!printf x >> runs; cat token" },
    },
  };
  const received: string[] = [];
  const runtime = new McpRuntime(
    config,
    f.directory,
    join(f.directory, "secrets-cache"),
    async (name, connection, signal) => {
      received.push(connection.headers!.Authorization);
      return f.connect(name, connection, signal);
    },
  );
  cleanup.push(() => runtime.close());
  const identity = runtime.identity("example");
  runtime.status();
  expect(await readdir(f.directory)).not.toContain("runs");
  await Promise.all([runtime.discover(), runtime.discover()]);
  await runtime.discover();
  expect(received).toEqual(["first-secret"]);
  const cached = new McpRuntime(
    config,
    f.directory,
    join(f.directory, "secrets-cache"),
    async () => {
      throw new Error("Must not connect");
    },
  );
  cleanup.push(() => cached.close());
  expect((await cached.discover()).tools).toHaveLength(1);
  expect(await readFile(join(f.directory, "runs"), "utf8")).toBe("x");
  const cache = await readFile(
    join(f.directory, "secrets-cache", `${identity}.json`),
    "utf8",
  );
  expect(cache).not.toContain("first-secret");
  expect(cache).not.toContain("cat token");
  await writeFile(join(f.directory, "token"), "rotated-secret");
  await runtime.reconnect("example");
  expect(received).toEqual(["first-secret", "rotated-secret"]);
  expect(runtime.identity("example")).toBe(identity);
  expect(await readFile(join(f.directory, "runs"), "utf8")).toBe("xx");
  config.example.headers.Authorization = "$!printf x >> runs; cat token";
  expect(runtime.identity("example")).not.toBe(identity);
});

test("closing the runtime cancels pending secret commands before connecting", async () => {
  const f = await fixture();
  const runtime = new McpRuntime(
    { example: { command: "fixture", env: { TOKEN: "!sleep 30" } } },
    f.directory,
    join(f.directory, "cancel-cache"),
    f.connect,
  );
  const pending = runtime.discover();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await runtime.close();
  expect((await pending).unavailable).toHaveLength(1);
  expect(f.connects()).toBe(0);
});

test("cold discovery shares one connection and calls via the official SDK", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([
    f.runtime.discover(),
    f.runtime.discover(),
  ]);
  expect(f.connects()).toBe(1);
  expect(first.tools).toEqual(second.tools);
  const result = await f.runtime.call(first.tools[0], { message: "hello" });
  expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  expect(f.calls()).toBe(1);
});

test("catalog cache loads without connecting", async () => {
  const f = await fixture();
  await f.runtime.discover();
  const runtime = new McpRuntime(
    { example: { command: "fixture" } },
    f.directory,
    join(f.directory, "cache"),
    async () => {
      throw new Error("Must not connect");
    },
  );
  cleanup.push(() => runtime.close());
  const result = await runtime.discover();
  expect(result.tools).toHaveLength(1);
  expect(result.unavailable).toEqual([]);
});

test("removed tools fail before execution", async () => {
  const f = await fixture();
  const { tools } = await f.runtime.discover();
  f.handles[0].remove();
  await expect(f.runtime.call(tools[0], { message: "hello" })).rejects.toThrow(
    "removed or its schema changed",
  );
  expect(f.calls()).toBe(0);
});

test("changed schemas require rediscovery rather than executing stale arguments", async () => {
  const f = await fixture();
  const { tools } = await f.runtime.discover();
  f.handles[0].update({ paramsSchema: z.object({ renamed: z.string() }) });
  await expect(f.runtime.call(tools[0], { message: "hello" })).rejects.toThrow(
    "schema changed",
  );
  expect(f.calls()).toBe(0);
  expect((await f.runtime.discover()).tools[0].schemaHash).not.toBe(
    tools[0].schemaHash,
  );
});

test("live HTTP authentication and permission failures have structured diagnostics", async () => {
  const f = await fixture();
  for (const [status, code] of [
    [401, "authentication_required"],
    [403, "permission_denied"],
  ] as const) {
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("private-token", { status }),
    });
    cleanup.push(() => Promise.resolve(http.stop(true)));
    const runtime = new McpRuntime(
      { example: { url: `http://127.0.0.1:${http.port}/mcp` } },
      f.directory,
      join(f.directory, `http-${status}`),
    );
    cleanup.push(() => runtime.close());
    const result = await runtime.discover();
    expect(result.diagnostics[0].code).toBe(code);
    expect(result.diagnostics[0].server).toBe("example");
    expect(result.unavailable[0]).toContain(`[${code}]`);
    expect(runtime.status()).toContain(`[${code}]`);
    expect(JSON.stringify(result)).not.toContain("private-token");
  }
});

test("failed secret lookups retain their diagnostic through discovery and status", async () => {
  const f = await fixture();
  const runtime = new McpRuntime(
    {
      example: {
        command: "fixture",
        env: { TOKEN: "!printf private-token >&2; exit 1" },
      },
    },
    f.directory,
    join(f.directory, "failed-secret"),
    f.connect,
  );
  cleanup.push(() => runtime.close());
  const result = await runtime.discover();
  expect(result.diagnostics[0].code).toBe("secret_lookup_failed");
  expect(result.diagnostics[0].operation).toBe("connect");
  expect(runtime.status()).toContain("[secret_lookup_failed]");
  expect(JSON.stringify(result)).not.toContain("private-token");
  expect(f.connects()).toBe(0);
});

test("partial discovery preserves healthy results and does not disclose error secrets", async () => {
  const f = await fixture();
  const runtime = new McpRuntime(
    { good: { command: "fixture" }, bad: { command: "bad" } },
    f.directory,
    join(f.directory, "other"),
    async (name, config, signal) => {
      if (name === "bad") throw new Error("secret-token");
      return f.connect(name, config, signal);
    },
  );
  cleanup.push(() => runtime.close());
  const result = await runtime.discover();
  expect(result.tools).toHaveLength(1);
  expect(result.unavailable).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("secret-token");
});

test("shutdown closes a connection that finishes late", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = false;
  const runtime = new McpRuntime(
    { late: { command: "fixture" } },
    f.directory,
    join(f.directory, "late"),
    async (...args) => {
      const connection = await f.connect(...args);
      const close = connection.client.close.bind(connection.client);
      connection.client.close = async () => {
        closed = true;
        await close();
      };
      await gate;
      return connection;
    },
  );
  const discovery = runtime.discover();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const shutdown = runtime.close();
  release();
  await shutdown;
  await discovery;
  expect(closed).toBe(true);
});

for (const protocol of [undefined, "legacy"] as const)
test(`real stdio transport loads and invokes tools (${protocol ?? "default auto"}), including MCP error results`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = new McpRuntime(
    {
      stdio: {
        protocol,
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/server.ts", import.meta.url))],
      },
    },
    directory,
    join(directory, "cache"),
  );
  cleanup.push(() => runtime.close());
  const { tools, unavailable } = await runtime.discover();
  expect(unavailable).toEqual([]);
  expect(tools).toHaveLength(2);
  const result = await runtime.call(tools.find((tool) => tool.name === "echo")!, {
    text: "hello stdio",
  });
  expect(result.content).toEqual([{ type: "text", text: "hello stdio" }]);
  const failure = await runtime.call(tools.find((tool) => tool.name === "fail")!, {});
  expect(failure.isError).toBe(true);
});

test("already-cancelled waiters still observe rejected shared work", async () => {
  const signal = AbortSignal.abort(new Error("Cancelled"));
  await expect(
    waitFor(Promise.reject(new Error("late failure")), signal),
  ).rejects.toThrow("Cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("cancelling one waiter does not cancel another", async () => {
  let resolve!: (value: number) => void;
  const shared = new Promise<number>((r) => {
    resolve = r;
  });
  const abort = new AbortController();
  const cancelled = waitFor(shared, abort.signal);
  const other = waitFor(shared);
  abort.abort(new Error("stop"));
  await expect(cancelled).rejects.toThrow("stop");
  resolve(42);
  expect(await other).toBe(42);
});
