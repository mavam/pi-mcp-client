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
    ui: {
      notify: (text: string) => notifications.push(text),
      select: async (_title: string, _options: string[]): Promise<string | undefined> =>
        undefined,
    },
  };
  cleanup.push(() => hooks.get("session_shutdown")({}, ctx));
  await hooks.get("session_start")({}, ctx);
  const execute = (name: string, args: object) =>
    tools.get(name).execute("id", args, ctx.signal, undefined, ctx);
  return {
    ctx,
    directory,
    activeTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
    tools,
    hooks,
    commands,
    execute,
    notifications,
    command: (args: string) => commands.get("mcp").handler(args, ctx),
  };
}

const fixtureServer = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/server.ts", import.meta.url))],
};

test("inspect includes disabled servers and never resolves or exposes connection secrets", async () => {
  const h = await host(
    JSON.stringify({
      mcpServers: {
        private: {
          command: "secret-command",
          args: ["secret-arg"],
          cwd: "secret-dir",
          env: { SECRET: "!touch should-not-exist" },
          disabled: true,
        },
        remote: {
          url: "https://example.com/secret-path?token=secret-query",
          headers: { Authorization: "secret-header" },
        },
      },
    }),
  );
  await h.command("inspect private");
  const local = h.notifications.at(-1)!;
  expect(local).toContain("disabled");
  expect(local).toContain("Arguments: 1");
  expect(local).not.toContain("secret-");
  expect(local).not.toContain("touch");
  await h.command("inspect remote");
  const remote = h.notifications.at(-1)!;
  expect(remote).toContain("disconnected");
  expect(remote).toContain("Headers: 1");
  expect(remote).not.toContain("secret-");
  expect(h.commands.get("mcp").getArgumentCompletions("inspect p")).toEqual([
    { value: "inspect private", label: "inspect private" },
  ]);
});

test("tool browsing lists filtered tools without activating any", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  let choices: string[] = [];
  h.ctx.ui.select = async (_title, values) => {
    choices = values;
    return values[0];
  };
  await h.command("tools example");
  expect(choices).toEqual(["1. echo", "2. fail"]);
  expect(h.notifications.at(-1)).toContain("Echo text");
  expect(h.activeTools()).toEqual(["mcp_search"]);
  expect([...h.tools.keys()]).toEqual(["mcp_search"]);
  await writeFile(
    join(h.directory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        example: { ...fixtureServer, excludeTools: ["fail"] },
      },
    }),
  );
  await h.command("reload");
  await h.command("tools example");
  expect(choices).toEqual(["1. echo"]);
  expect(h.activeTools()).toEqual(["mcp_search"]);
});

test("reload retains unchanged active definitions and unrelated tools, but not inactive definitions", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const echo = (await h.execute("mcp_search", { query: "example.echo" })).details
    .loaded[0].nativeName;
  const fail = (await h.execute("mcp_search", { query: "example.fail" })).details
    .loaded[0].nativeName;
  h.setActiveTools(["mcp_search", echo, "unrelated"]);
  await h.command("reload");
  expect(h.activeTools()).toEqual(["mcp_search", "unrelated", echo]);
  expect(h.activeTools()).not.toContain(fail);
  await h.command("status");
  expect(h.notifications.at(-1)).toContain("disconnected");
  const result = await h.execute(echo, { text: "after reload" });
  expect(JSON.stringify(result.content)).toContain("after reload");
});

for (const change of ["changed", "disabled", "removed"])
  test(`reload deactivates ${change} servers and blocks old tool handlers`, async () => {
    const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
    const name = (await h.execute("mcp_search", { query: "example.echo" })).details
      .loaded[0].nativeName;
    await writeFile(
      join(h.directory, "mcp.json"),
      JSON.stringify({
        mcpServers:
          change === "removed"
            ? {}
            : {
                example: {
                  ...fixtureServer,
                  ...(change === "disabled"
                    ? { disabled: true }
                    : { excludeTools: ["echo"] }),
                },
              },
      }),
    );
    await h.command("reload");
    expect(h.activeTools()).not.toContain(name);
    expect((await h.execute(name, { text: "must not execute" })).details.failed).toBe(
      true,
    );
  });

test("invalid reload leaves the previous working configuration and tools intact", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const name = (await h.execute("mcp_search", { query: "example.echo" })).details
    .loaded[0].nativeName;
  for (const invalid of [
    '{"mcpServers": secret-token',
    JSON.stringify({
      mcpServers: { bad: { url: "https://user:secret-token@example.com" } },
    }),
  ]) {
    await writeFile(join(h.directory, "mcp.json"), invalid);
    await h.command("reload");
    expect(h.notifications.at(-1)).toContain("configuration_invalid");
    expect(h.notifications.at(-1)).not.toContain("secret-token");
    expect(h.activeTools()).toContain(name);
    expect((await h.execute(name, { text: "still works" })).details.failed).not.toBe(
      true,
    );
  }
});

test("reload recovers from startup errors and respects project trust", async () => {
  const h = await host("bad JSON");
  await writeFile(
    join(h.directory, "mcp.json"),
    JSON.stringify({ mcpServers: { example: fixtureServer } }),
  );
  await writeFile(
    join(h.directory, ".mcp.json"),
    JSON.stringify({ mcpServers: { example: { ...fixtureServer, disabled: true } } }),
  );
  await h.command("reload");
  expect(
    (await h.execute("mcp_search", { query: "example.echo" })).details.loaded,
  ).toHaveLength(1);
  h.ctx.isProjectTrusted = () => true;
  await h.command("reload");
  await h.command("inspect example");
  expect(h.notifications.at(-1)).toContain("disabled");
  expect(h.activeTools()).toEqual(["mcp_search"]);
});

test("empty tool catalogs, picker cancellation, and headless browsing don't activate tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await h.command("tools example"); // The picker returns undefined.
  expect(h.activeTools()).toEqual(["mcp_search"]);
  await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: {
    example: { ...fixtureServer, includeTools: [] },
  } }));
  await h.command("reload");
  await h.command("tools example");
  expect(h.notifications.at(-1)).toContain("no tools available");
  h.ctx.hasUI = false;
  await expect(h.command("tools example")).rejects.toThrow("interactive UI");
  expect(h.activeTools()).toEqual(["mcp_search"]);
});

test("cancelled reloads do not replace the current configuration", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  h.ctx.signal = AbortSignal.abort();
  await h.command("reload");
  expect(h.notifications.at(-1)).toContain("cancelled");
  await h.command("inspect example");
  expect(h.notifications.at(-1)).toContain("Server: example");
});

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
