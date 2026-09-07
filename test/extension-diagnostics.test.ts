import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function host(configuration: string) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-diags-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "mcp.json"), configuration);
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  let active = ["mcp_search"];
  extension(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, fn: any) => hooks.set(name, fn),
      getActiveTools: () => active,
      getAllTools: () => [...tools.values()],
      setActiveTools: (names: string[]) => {
        active = names;
      },
    } as unknown as ExtensionAPI,
    { agentDir: directory },
  );
  const ctx = {
    cwd: directory,
    signal: new AbortController().signal,
    hasUI: true,
    mode: "print",
    isProjectTrusted: () => false,
    waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] },
    ui: { notify: (text: string) => notifications.push(text) },
  };
  cleanup.push(() => hooks.get("session_shutdown")({}, ctx));
  await hooks.get("session_start")({}, ctx);
  const execute = (name: string, args: object) =>
    tools.get(name).execute("id", args, ctx.signal, undefined, ctx);
  return {
    ctx,
    execute,
    notifications,
    command: (args: string) => commands.get("mcp").handler(args, ctx),
  };
}

test("configuration errors reach search and status without leaking malformed JSON", async () => {
  const h = await host('{"mcpServers": private-token');
  const result = await h.execute("mcp_search", { query: "anything" });
  expect(result.details.failed).toBe(true);
  expect(result.details.diagnostics[0].code).toBe("configuration_invalid");
  await h.command("status");
  expect(h.notifications.at(-1)).toContain("[configuration_invalid]");
  expect(JSON.stringify([result, h.notifications])).not.toContain("private-token");
});

test("secret failures reach search details, status, and reconnect notifications", async () => {
  const h = await host(
    JSON.stringify({
      mcpServers: {
        example: {
          command: "unused",
          env: { TOKEN: "!printf private-token >&2; exit 1" },
        },
      },
    }),
  );
  const result = await h.execute("mcp_search", { query: "anything" });
  expect(result.details.failed).toBe(true);
  expect(result.details.diagnostics[0].code).toBe("secret_lookup_failed");
  expect(result.details.rows[0].state).toBe("failed");
  await h.command("status");
  expect(h.notifications.at(-1)).toContain("[secret_lookup_failed]");
  await h.command("reconnect example");
  expect(h.notifications.at(-1)).toContain("[secret_lookup_failed]");
  expect(JSON.stringify([result, h.notifications])).not.toContain("private-token");
});

test("native tools distinguish server-reported errors from cancelled calls", async () => {
  const h = await host(
    JSON.stringify({
      mcpServers: {
        example: {
          command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/server.ts", import.meta.url))],
        },
      },
    }),
  );
  const loaded = await h.execute("mcp_search", { query: "example.fail" });
  const name = loaded.details.loaded[0].nativeName;
  const result = await h.execute(name, {});
  expect(result.details.diagnostics[0].code).toBe("tool_error");
  expect(result.details.failed).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Expected failure");
  h.ctx.signal = AbortSignal.abort(new Error("private-token"));
  const cancelled = await h.execute(name, {});
  expect(cancelled.details.diagnostics[0].code).toBe("cancelled");
  expect(cancelled.details.rows[0].state).toBe("cancelled");
  expect(JSON.stringify(cancelled.content)).toContain("not replayed");
  expect(JSON.stringify(cancelled)).not.toContain("private-token");
});
