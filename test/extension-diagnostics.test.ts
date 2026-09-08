import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { restoredTools } from "../src/exposure.js";
import { McpRuntime } from "../src/runtime.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function host(configuration: string, excluded: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-diags-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "mcp.json"), configuration);
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  let active = ["mcp_tools"];
  extension(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      on: (name: string, fn: any) => hooks.set(name, fn),
      getActiveTools: () => active,
      getAllTools: () => [...tools.values()],
      setActiveTools: (names: string[]) => {
        active = names.filter((name) => !excluded.includes(name));
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
  const execute = (name: string, args: object, onUpdate?: (result: any) => void) =>
    tools.get(name).execute("id", args, ctx.signal, onUpdate, ctx);
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

test("discovery, including exact names, never registers, activates, or restores candidates", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  h.setActiveTools(["mcp_tools", "unrelated"]);
  for (const query of ["echo", "example.echo", "mcp__example__echo"]) {
    const result = await h.execute("mcp_tools", { query });
    expect(h.activeTools()).toEqual(["mcp_tools", "unrelated"]);
    expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
    expect(result.details.candidates).toHaveLength(1);
    expect(result.details.rows[0].label).toBe("example.echo");
    expect(result.details.rows[0].inlineDescription).toBe("Echo text (required: text)");
    expect(result.details.rows[0].state).toBe("candidate");
    expect(result.details).not.toHaveProperty("loaded");
    expect(result.content[0].text).toContain("example.echo — Echo text (required: text)");
    expect(result.content[0].text).toEndWith('No tools activated. Call mcp_tools({activate: [...]}) with the identifiers you need.');
    expect(restoredTools([{ type: "message", message: { role: "toolResult", toolName: "mcp_tools", details: result.details, isError: false } } as any])).toEqual([]);
  }
  await h.execute("mcp_tools", { activate: ["example.echo"] });
  const result = await h.execute("mcp_tools", { query: "example.echo" });
  expect(result.content[0].text).toContain("(required: text) [loaded]");
  expect(result.details.rows[0]).toEqual({
    label: "example.echo", inlineDescription: "Echo text (required: text)", state: "active",
  });
  expect(result.details).not.toHaveProperty("loaded");
  const hint = h.hooks.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  expect(hint).toContain("discovery never activates");
  expect(hint).toContain('activate: ["server.tool"]');
});

test("activation needs no search, deduplicates aliases, and loads only explicit identifiers", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer, untouched: fixtureServer } }));
  h.setActiveTools(["mcp_tools", "unrelated"]);
  const result = await h.execute("mcp_tools", { activate: ["example.echo", "example.echo", "mcp__example__echo"] });
  expect(result.details.loaded).toHaveLength(1);
  expect(result.details.rows).toHaveLength(2);
  expect(result.details.failed).toBe(false);
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", "mcp__example__echo"]);
  expect([...h.tools.keys()]).toEqual(["mcp_tools", "mcp__example__echo"]);
  await h.command("inspect untouched");
  expect(h.notifications.at(-1)).toContain("disconnected");
  const again = await h.execute("mcp_tools", { activate: ["example.echo"] });
  expect(again.content[0].text).toContain("already loaded");
  expect(again.details.rows).toEqual([{ label: "example.echo", state: "done" }]);
  expect(result.details.rows[0]).toEqual({ label: "example.echo", state: "done" });
});

test("typos fail with catalog suggestions, while partial activation succeeds", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const typo = await h.execute("mcp_tools", { activate: ["example.ech"] });
  expect(typo.details.failed).toBe(true);
  expect(typo.content[0].text).toContain("not loaded — unknown identifier");
  expect(typo.content[0].text).toContain("nearest catalog names: example.echo");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
  expect(h.hooks.get("tool_result")({ toolName: "mcp_tools", details: typo.details })).toEqual({ isError: true });
  const partial = await h.execute("mcp_tools", { activate: ["example.echo", "example.ech"] });
  expect(partial.details.loaded).toHaveLength(1);
  expect(partial.details.failed).toBe(false);
  expect(partial.details.rows.map((row: any) => row.state)).toEqual(["done", "failed"]);
  expect(h.hooks.get("tool_result")({ toolName: "mcp_tools", details: partial.details })).toBeUndefined();
});

test("invalid argument combinations fail before any discovery or transport work", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const discover = spyOn(McpRuntime.prototype, "discover");
  try {
    for (const args of [
      {}, { query: "echo", activate: ["example.echo"] }, { server: "example" },
      { limit: 5 }, { activate: ["example.echo"], server: "example" },
      { activate: ["example.echo"], limit: 5 }, { activate: [] },
      { activate: Array(51).fill("example.echo") }, { activate: [""] },
      { query: " " }, { query: "echo", limit: 0 }, { query: "echo", extra: true },
    ]) {
      const result = await h.execute("mcp_tools", args);
      expect(result.details.failed).toBe(true);
      expect(result.content[0].text).toContain("exactly one of");
      expect(result.content[0].text).toContain("server and limit are valid only with query");
    }
    expect(discover).not.toHaveBeenCalled();
    expect(h.activeTools()).toEqual(["mcp_tools"]);
  } finally { discover.mockRestore(); }
});

test("activation reports restrictions, collisions, and unavailable servers separately", async () => {
  const h = await host(JSON.stringify({ mcpServers: {
    example: fixtureServer,
    offline: { ...fixtureServer, disabled: true },
  } }), ["mcp__example__echo"]);
  h.tools.set("mcp__example__fail", { name: "mcp__example__fail" });
  const result = await h.execute("mcp_tools", { activate: ["example.echo", "example.fail", "offline.echo"] });
  expect(result.details.failed).toBe(true);
  expect(result.details.loaded).toEqual([]);
  expect(result.content[0].text).toContain("restricted by Pi");
  expect(result.content[0].text).toContain("name collision");
  expect(result.content[0].text).toContain("server unavailable");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("concurrent activations cumulatively expose their exact selections", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer, other: fixtureServer } }));
  const results = await Promise.all(["example.echo", "example.fail", "other.echo"].map((id) =>
    h.execute("mcp_tools", { activate: [id] }),
  ));
  expect(results.every((result) => result.details.loaded.length === 1)).toBe(true);
  expect([...h.activeTools()].sort()).toEqual(["mcp_tools", "mcp__example__echo", "mcp__example__fail", "mcp__other__echo"].sort());
});

for (const interruption of ["cancel", "session change"])
  test(`activation does not expose tools after ${interruption} during discovery`, async () => {
    const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
    const original = McpRuntime.prototype.discover;
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const discover = spyOn(McpRuntime.prototype, "discover").mockImplementation(async function (this: McpRuntime, ...args) {
      const result = await original.apply(this, args);
      if (interruption === "cancel") controller.abort();
      else await h.hooks.get("session_start")({}, h.ctx);
      return result;
    });
    try {
      const result = await h.execute("mcp_tools", { activate: ["example.echo"] });
      expect(result.details.failed).toBe(true);
      expect(h.activeTools()).toEqual(["mcp_tools"]);
      expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
    } finally { discover.mockRestore(); }
  });

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
    { value: "inspect private", label: "private" },
  ]);
});

test("command completion suggests actions first and servers only after an action", async () => {
  const h = await host(JSON.stringify({ mcpServers: {
    linear: fixtureServer,
    cloudflare: fixtureServer,
    disabled: { ...fixtureServer, disabled: true },
  } }));
  const complete = h.commands.get("mcp").getArgumentCompletions;
  expect(complete("")).toEqual(
    ["list", "status", "reload", "enable", "disable", "inspect", "tools", "auth", "reconnect", "refresh"]
      .map((value) => ({ value, label: value })),
  );
  expect(complete("to")).toEqual([{ value: "tools", label: "tools" }]);
  expect(complete("tools")).toEqual([{ value: "tools", label: "tools" }]);
  for (const action of ["tools", "auth", "reconnect", "refresh"]) {
    expect(complete(`${action} `)).toEqual([
      { value: `${action} cloudflare`, label: "cloudflare" },
      { value: `${action} linear`, label: "linear" },
    ]);
  }
  expect(complete("tools li")).toEqual([{ value: "tools linear", label: "linear" }]);
  expect(complete("  tools   li")).toEqual(complete("tools li"));
  expect(complete("inspect d")).toEqual([{ value: "inspect disabled", label: "disabled" }]);
  for (const input of ["reload ", "list ", "status ", "unknown ", "tools missing", "tools linear "])
    expect(complete(input)).toEqual([]);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  expect(h.notifications).toEqual([]);
});

test("command completion reflects configuration reloads and works without servers", async () => {
  const h = await host(JSON.stringify({ mcpServers: {} }));
  const complete = h.commands.get("mcp").getArgumentCompletions;
  expect(complete("tools")).toEqual([{ value: "tools", label: "tools" }]);
  expect(complete("tools ")).toEqual([]);
  await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: { linear: fixtureServer } }));
  await h.command("reload");
  expect(complete("tools ")).toEqual([{ value: "tools linear", label: "linear" }]);
});

test("enable and disable persist, reconcile tools, and keep discovery lazy", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer, other: fixtureServer } }));
  const echo = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details.loaded[0].nativeName;
  const other = (await h.execute("mcp_tools", { activate: ["other.echo"] })).details.loaded[0].nativeName;
  h.setActiveTools(["mcp_tools", "unrelated", echo, other]);
  // An already enabled server must not change identity or drop its active tools.
  const before = await readFile(join(h.directory, "mcp.json"), "utf8");
  await h.command("enable example");
  expect(h.activeTools()).toContain(echo);
  expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(before);
  await h.command("disable example");
  expect(h.notifications.at(-1)).toContain("disabled in global configuration");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", other]);
  expect((await h.execute(echo, { text: "blocked" })).details.failed).toBe(true);
  expect((await h.execute("mcp_tools", { query: "example.echo" })).details.loaded ?? []).toEqual([]);
  expect(h.hooks.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt).not.toContain("- example");
  const complete = h.commands.get("mcp").getArgumentCompletions;
  expect(complete("enable ")).toEqual([{ value: "enable example", label: "example" }]);
  expect(complete("disable ")).toEqual([{ value: "disable other", label: "other" }]);
  await h.command("disable example");
  await h.command("reload");
  await h.command("inspect example");
  expect(h.notifications.at(-1)).toContain("disabled");
  await h.command("enable example");
  expect(h.notifications.at(-1)).toContain("enabled in global configuration");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", other]);
  await h.command("inspect example");
  expect(h.notifications.at(-1)).toContain("disconnected");
  const loaded = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details.loaded;
  expect(loaded).toHaveLength(1);
  expect(JSON.stringify((await h.execute(loaded[0].nativeName, { text: "back" })).content)).toContain("back");
  const document = JSON.parse(await readFile(join(h.directory, "mcp.json"), "utf8"));
  expect(document.mcpServers.example.disabled).toBe(false);
  expect(document.mcpServers.other).toEqual(fixtureServer);
});

test("toggles wait for idle and reject malformed commands without writes", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const path = join(h.directory, "mcp.json");
  const before = await readFile(path, "utf8");
  for (const args of ["enable", "disable", "disable missing", "enable example extra", "disable example extra"]) {
    await h.command(args);
    expect(h.notifications.at(-1)).toContain("Usage:");
    expect(await readFile(path, "utf8")).toBe(before);
  }
  let release!: () => void;
  h.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
  const disabling = h.command("disable example");
  expect(await readFile(path, "utf8")).toBe(before);
  release();
  await disabling;
  expect(JSON.parse(await readFile(path, "utf8")).mcpServers.example.disabled).toBe(true);
});

test("a session change while waiting for idle cancels a toggle", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const path = join(h.directory, "mcp.json");
  const before = await readFile(path, "utf8");
  let release!: () => void;
  h.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
  const disabling = h.command("disable example");
  await h.hooks.get("session_shutdown")({}, h.ctx);
  release();
  await disabling;
  expect(h.notifications.at(-1)).toContain("session changed");
  expect(await readFile(path, "utf8")).toBe(before);
});

test("failed enabling preserves disk and runtime without revealing secrets", async () => {
  const h = await host(JSON.stringify({ mcpServers: {
    example: fixtureServer,
    invalid: { url: "https://user:private-token@example.com", disabled: true },
  } }));
  const echo = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details.loaded[0].nativeName;
  const before = await readFile(join(h.directory, "mcp.json"), "utf8");
  await h.command("enable invalid");
  expect(h.notifications.at(-1)).toContain("configuration_invalid");
  expect(h.notifications.at(-1)).not.toContain("private-token");
  expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(before);
  expect(h.activeTools()).toContain(echo);
  expect((await h.execute(echo, { text: "still works" })).details.failed).not.toBe(true);
  h.ctx.hasUI = false;
  await h.command("disable example");
  await expect(h.command("enable invalid")).rejects.toThrow("configuration_invalid");
});

test("tool browsing lists filtered tools without activating any", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  let choices: string[] = [];
  h.ctx.ui.select = async (_title, values) => {
    choices = values;
    return values[0];
  };
  await h.command("tools example");
  expect(choices).toEqual(["1. echo: Echo text", "2. fail: Return a tool failure"]);
  expect(h.notifications.at(-1)).toContain("Echo text");
  expect(h.notifications.at(-1)).toContain("text: string (required)");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
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
  expect(choices).toEqual(["1. echo: Echo text"]);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("reload retains unchanged active definitions and unrelated tools, but not inactive definitions", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const echo = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details
    .loaded[0].nativeName;
  const fail = (await h.execute("mcp_tools", { activate: ["example.fail"] })).details
    .loaded[0].nativeName;
  h.setActiveTools(["mcp_tools", echo, "unrelated"]);
  await h.command("reload");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", echo]);
  expect(h.activeTools()).not.toContain(fail);
  await h.command("status");
  expect(h.notifications.at(-1)).toContain("idle");
  const result = await h.execute(echo, { text: "after reload" });
  expect(JSON.stringify(result.content)).toContain("after reload");
});

for (const change of ["changed", "disabled", "removed"])
  test(`reload deactivates ${change} servers and blocks old tool handlers`, async () => {
    const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
    const name = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details
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
  const name = (await h.execute("mcp_tools", { activate: ["example.echo"] })).details
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
    (await h.execute("mcp_tools", { activate: ["example.echo"] })).details.loaded,
  ).toHaveLength(1);
  h.ctx.isProjectTrusted = () => true;
  await h.command("reload");
  await h.command("inspect example");
  expect(h.notifications.at(-1)).toContain("disabled");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("empty tool catalogs, picker cancellation, and headless browsing don't activate tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await h.command("tools example"); // The picker returns undefined.
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: {
    example: { ...fixtureServer, includeTools: [] },
  } }));
  await h.command("reload");
  await h.command("tools example");
  expect(h.notifications.at(-1)).toContain("no tools available");
  h.ctx.hasUI = false;
  await expect(h.command("tools example")).rejects.toThrow("interactive UI");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("list and status show the same matrix without connecting or loading tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await h.command("list");
  const listing = h.notifications.at(-1)!;
  expect(listing).toContain("○ example");
  expect(listing).toContain("idle");
  expect(listing).not.toContain("unknown catalog tools");
  expect(listing).toContain("Connections open on demand");
  await h.command("status");
  expect(h.notifications.at(-1)).toBe(listing);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await h.execute("mcp_tools", { activate: ["example.echo"] });
  await h.command("list");
  expect(h.notifications.at(-1)).toContain("● example");
  expect(h.notifications.at(-1)).toMatch(/connected\s+2\s+1/);
});

test("successful management actions use checkmark notifications", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  for (const action of ["refresh example", "reconnect example", "reload"]) {
    await h.command(action);
    expect(h.notifications.at(-1)).toStartWith("✔︎ ");
    expect(h.notifications.at(-1)).not.toContain("mcp_tools");
    expect(h.notifications.at(-1)).not.toContain("Search to load");
  }
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
  const result = await h.execute("mcp_tools", { query: "anything" });
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
  const result = await h.execute("mcp_tools", { query: "anything" });
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
  const loaded = await h.execute("mcp_tools", { activate: ["example.fail"] });
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
