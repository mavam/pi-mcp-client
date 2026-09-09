import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { restoredTools } from "../src/exposure.js";
import { prepareTool } from "../src/catalog.js";
import { McpRuntime } from "../src/runtime.js";
import { OAuthProvider, type CredentialStoreFactory } from "../src/auth.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function host(configuration: string, excluded: string[] = [], credentialStore?: CredentialStoreFactory) {
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
    { agentDir: directory, credentialStore },
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

test("add is lazy and remove deactivates affected tools without touching credentials", async () => {
  let credentialAccesses = 0;
  const h = await host(JSON.stringify({ mcpServers: { other: fixtureServer } }), [], async () => {
    credentialAccesses++;
    throw new Error("must not access credentials");
  });
  h.setActiveTools(["mcp_tools", "unrelated"]);
  await h.execute("mcp_tools", { activate: ["other.echo"] });
  await h.command(`add --scope global example -- ${JSON.stringify(fixtureServer.command)} ${JSON.stringify(fixtureServer.args[0])}`);
  expect(h.notifications.at(-1)).toContain("saved in global configuration");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", "mcp__other__echo"]);
  await h.command("get example");
  expect(h.notifications.at(-1)).toContain("disconnected");
  await h.execute("mcp_tools", { activate: ["example.echo"] });
  const old = h.tools.get("mcp__example__echo");
  await h.command("remove --scope global example");
  expect(h.notifications.at(-1)).toContain("Credentials were retained");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", "mcp__other__echo"]);
  const result = await old.execute("old", { message: "blocked" }, h.ctx.signal, undefined, h.ctx);
  expect(result.details.failed).toBe(true);
  expect(h.commands.get("mcp").getArgumentCompletions("remove --scope global "))
    .toEqual([{ value: "remove --scope global other", label: "other" }]);
  expect(credentialAccesses).toBe(0);
});

test("scoped commands reconcile override replacement and global fallback without activation", async () => {
  const h = await host(JSON.stringify({ mcpServers: { docs: fixtureServer } }));
  h.ctx.isProjectTrusted = () => true;
  await h.execute("mcp_tools", { activate: ["docs.echo"] });
  await h.command("add --scope project --replace docs https://project.example/mcp");
  expect(h.notifications.at(-1)).toContain("saved in project configuration");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await h.command("get docs");
  expect(h.notifications.at(-1)).toContain("Transport: HTTP");
  await h.command("remove --scope project docs");
  expect(h.notifications.at(-1)).toContain("other scope remains effective");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await h.command("get docs");
  expect(h.notifications.at(-1)).toContain("Transport: stdio");
  expect(h.notifications.at(-1)).toContain("disconnected");
});

test("configuration commands wait for idle, serialize updates, and reject unsafe edits without writes", async () => {
  const h = await host(JSON.stringify({ mcpServers: {} }));
  const path = join(h.directory, "mcp.json");
  const before = await readFile(path, "utf8");
  let finish!: () => void;
  h.ctx.waitForIdle = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = h.command("add --scope global first https://first.example");
  await Promise.resolve();
  expect(await readFile(path, "utf8")).toBe(before);
  finish();
  await pending;
  h.ctx.waitForIdle = async () => {};
  await Promise.all([
    h.command("add --scope global second https://second.example"),
    h.command("add --scope global third https://third.example"),
  ]);
  expect(h.commands.get("mcp").getArgumentCompletions("get ")).toHaveLength(3);
  const saved = await readFile(path, "utf8");
  for (const command of [
    "add --scope project local https://project.example", "add --scope global first https://duplicate.example",
    "add --scope global bad ftp://private-secret", "remove --scope global missing",
    "add --scope global --header private-secret bad https://example.com",
  ]) {
    await h.command(command);
    expect(h.notifications.at(-1)).not.toContain("private-secret");
    expect(await readFile(path, "utf8")).toBe(saved);
  }
  h.ctx.signal = AbortSignal.abort();
  await h.command("remove --scope global first");
  expect(h.notifications.at(-1)).toContain("cancelled");
  expect(await readFile(path, "utf8")).toBe(saved);
});

test("a session switch while add waits for idle prevents mutation", async () => {
  const h = await host(JSON.stringify({ mcpServers: {} }));
  let finish!: () => void;
  h.ctx.waitForIdle = () => new Promise<void>((resolve) => { finish = resolve; });
  const pending = h.command("add --scope global docs https://example.com");
  await Promise.resolve();
  await h.hooks.get("session_start")({}, h.ctx);
  finish();
  await pending;
  expect(h.notifications.at(-1)).toContain("session changed");
  expect(JSON.parse(await readFile(join(h.directory, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
});

test("removing a disabled OAuth server never accesses its credentials", async () => {
  let credentials = 0;
  const h = await host(JSON.stringify({ mcpServers: {
    private: { url: "https://example.com/mcp", oauth: true, disabled: true },
  } }), [], async () => { credentials++; throw new Error("must not access credentials"); });
  await h.command("remove --scope global private");
  expect(h.notifications.at(-1)).toContain("Credentials were retained");
  expect(credentials).toBe(0);
  expect(JSON.parse(await readFile(join(h.directory, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
});

test("headless add and remove do not require UI or execute secret commands", async () => {
  const h = await host(JSON.stringify({ mcpServers: {} }));
  h.ctx.hasUI = false;
  const marker = join(h.directory, "must-not-exist");
  await h.command(`add --scope global --header 'X-Key: !touch ${marker}' docs https://example.com`);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await expect(readFile(marker)).rejects.toThrow();
  await h.command("remove --scope global docs");
  expect(JSON.parse(await readFile(join(h.directory, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
  await expect(h.command("remove --scope global missing")).rejects.toThrow("selected scope");
});

test("logout accepts disabled servers, preserves configuration, and explains external credentials", async () => {
  let record: string | null = null;
  const store = { read: () => record, write: (value: string) => { record = value; }, remove: () => { record = null; } };
  const configuration = JSON.stringify({ mcpServers: {
    example: { url: "https://oauth.example/mcp", oauth: true },
    alias: { url: "https://oauth.example/mcp", oauth: true, disabled: true },
    external: { url: "https://external.example/mcp", headers: { Authorization: "!never-execute" } },
  } });
  const h = await host(configuration, [], async () => store);
  const provider = new OAuthProvider("https://oauth.example/mcp", store);
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer" });
  await h.command("get alias");
  expect(h.notifications.at(-1)).toContain("stored tokens (validity not checked)");
  expect(h.notifications.at(-1)).not.toContain("private-token");
  const disconnect = spyOn(McpRuntime.prototype, "disconnect");
  const discover = spyOn(McpRuntime.prototype, "discover").mockResolvedValue({
    tools: [prepareTool("example", "fixture", { name: "echo", inputSchema: { type: "object" } })],
    diagnostics: [], unavailable: [], warnings: [],
  });
  try {
    h.setActiveTools(["mcp_tools", "unrelated"]);
    await h.execute("mcp_tools", { activate: ["example.echo"] });
    expect(h.activeTools()).toContain("mcp__example__echo");
    await h.command("logout alias");
    expect(disconnect).toHaveBeenCalledWith(["example", "alias"]);
    expect(record).toBeNull();
    expect(h.notifications.at(-1)).toContain("local OAuth credentials removed");
    expect(h.notifications.at(-1)).toContain("Remote revocation could not be confirmed");
    expect(h.activeTools()).toEqual(["mcp_tools", "unrelated"]);
    await h.command("logout alias");
    expect(h.notifications.at(-1)).toContain("No stored tokens");
    await h.command("get alias");
    expect(h.notifications.at(-1)).toContain("no stored tokens");
    await h.command("logout external");
    expect(h.notifications.at(-1)).toContain("externally managed");
    expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(configuration);
    expect(h.commands.get("mcp").getArgumentCompletions("logout a")).toEqual([{ value: "logout alias", label: "alias" }]);
    for (const input of ["logout", "logout missing", "logout alias extra"] ) {
      await h.command(input);
      expect(h.notifications.at(-1)).toContain("Usage:");
    }
  } finally { disconnect.mockRestore(); discover.mockRestore(); }
});

test("get and logout select only the configured OAuth client identity", async () => {
  const stores = new Map<string, { read: () => string | null; write: (value: string) => void; remove: () => void }>();
  const url = "https://clients.example/mcp";
  for (const clientId of ["first", "second"]) {
    let record: string | null = null;
    const store = { read: () => record, write: (value: string) => { record = value; }, remove: () => { record = null; } };
    new OAuthProvider(url, store, undefined, clientId).saveTokens({ access_token: "private-token", token_type: "Bearer", issuer: "https://issuer.example" });
    stores.set(clientId, store);
  }
  const h = await host(JSON.stringify({ mcpServers: {
    first: { url, oauth: true, oauthClientId: "first", disabled: true },
    second: { url, oauth: true, oauthClientId: "second" },
  } }), [], async (resolved, clientId) => {
    expect(resolved).toBe(url);
    return stores.get(clientId!)!;
  });
  await h.command("get first");
  expect(h.notifications.at(-1)).toContain("pre-registered public client");
  expect(h.notifications.at(-1)).toContain("stored tokens");
  const disconnect = spyOn(McpRuntime.prototype, "disconnect");
  try {
    h.ctx.signal = AbortSignal.abort(); // Skip remote revocation; local deletion still completes.
    await h.command("logout first");
    expect(disconnect).toHaveBeenCalledWith(["first"]);
    expect(stores.get("first")!.read()).toBeNull();
    expect(stores.get("second")!.read()).not.toBeNull();
    expect(h.notifications.at(-1)).toContain("local OAuth credentials removed");
  } finally { disconnect.mockRestore(); }
});

test("logout reports store failures without claiming success or exposing raw errors", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: { url: "https://oauth.example/mcp", oauth: true } } }), [],
    async () => ({ read: () => null, write: () => {}, remove: () => { throw new Error("private-keyring-error"); } }));
  await h.command("logout example");
  expect(h.notifications.at(-1)).not.toContain("credentials removed");
  expect(h.notifications.at(-1)).not.toContain("private-keyring-error");
});

test("removed command names fail without connecting and login uses the new name", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: { command: "never-start" } } }));
  const connect = spyOn(McpRuntime.prototype, "reconnect");
  try {
    for (const action of ["auth", "inspect"]) {
      await h.command(`${action} example`);
      expect(h.notifications.at(-1)).toContain("Unknown MCP command");
      expect(h.commands.get("mcp").getArgumentCompletions(action)).toEqual([]);
    }
    await h.command("login example");
    expect(h.notifications.at(-1)).toContain("Enable oauth");
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
  }
});

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
    expect(result.details.rows[0].state).toBe("candidate");
    expect(result.details).not.toHaveProperty("loaded");
    expect(restoredTools([{ type: "message", message: { role: "toolResult", toolName: "mcp_tools", details: result.details, isError: false } } as any])).toEqual([]);
  }
  await h.execute("mcp_tools", { activate: ["example.echo"] });
  const result = await h.execute("mcp_tools", { query: "example.echo" });
  expect(result.details.rows[0].state).toBe("active");
  expect(result.details).not.toHaveProperty("loaded");
});

test("unknown and disabled discovery servers fail without connecting or activating", async () => {
  const h = await host(JSON.stringify({ mcpServers: {
    example: fixtureServer,
    offline: { ...fixtureServer, disabled: true },
  } }));
  const catalog = spyOn(McpRuntime.prototype, "catalog");
  try {
    for (const [server, code] of [
      ["gog", "server_unknown"], ["toString", "server_unknown"],
      ["offline", "server_disabled"],
    ]) {
      const result = await h.execute("mcp_tools", { query: "gmail search", server });
      expect(result.details.failed).toBe(true);
      expect(result.details.diagnostics[0]).toMatchObject({ code, server, operation: "search" });
      expect(result.content[0].text).toMatch(/[Oo]mit server/);
      expect(result.content[0].text).not.toContain("tool_changed");
      expect(result.content[0].text).not.toContain("activate");
      expect(result.details).not.toHaveProperty("loaded");
    }
    expect(catalog).not.toHaveBeenCalled();
    expect(h.activeTools()).toEqual(["mcp_tools"]);
    expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
  } finally { catalog.mockRestore(); }
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
  await h.command("get untouched");
  expect(h.notifications.at(-1)).toContain("disconnected");
  const again = await h.execute("mcp_tools", { activate: ["example.echo"] });
  expect(again.details.loaded).toEqual(result.details.loaded);
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", "mcp__example__echo"]);
});

test("typos fail with catalog suggestions, while partial activation succeeds", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const typo = await h.execute("mcp_tools", { activate: ["example.ech"] });
  expect(typo.details.failed).toBe(true);
  expect(typo.content[0].text).toContain("example.echo");
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
      // The error must identify both legal modes without pinning its prose.
      expect(result.content[0].text).toContain("query");
      expect(result.content[0].text).toContain("activate");
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

test("get includes disabled servers and never resolves or exposes connection secrets", async () => {
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
  await h.command("get private");
  const local = h.notifications.at(-1)!;
  expect(local).toContain("disabled");
  expect(local).toContain("Arguments: 1");
  expect(local).not.toContain("secret-");
  expect(local).not.toContain("touch");
  await h.command("get remote");
  const remote = h.notifications.at(-1)!;
  expect(remote).toContain("disconnected");
  expect(remote).toContain("Headers: 1");
  expect(remote).not.toContain("secret-");
  expect(h.commands.get("mcp").getArgumentCompletions("get p")).toEqual([
    { value: "get private", label: "private" },
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
    ["list", "status", "reload", "add", "remove", "enable", "disable", "get", "tools", "login", "logout", "reconnect", "refresh"]
      .map((value) => ({ value, label: value })),
  );
  expect(complete("to")).toEqual([{ value: "tools", label: "tools" }]);
  expect(complete("tools")).toEqual([{ value: "tools", label: "tools" }]);
  for (const action of ["tools", "login", "reconnect", "refresh"]) {
    expect(complete(`${action} `)).toEqual([
      { value: `${action} cloudflare`, label: "cloudflare" },
      { value: `${action} linear`, label: "linear" },
    ]);
  }
  expect(complete("tools li")).toEqual([{ value: "tools linear", label: "linear" }]);
  expect(complete("  tools   li")).toEqual(complete("tools li"));
  expect(complete("get d")).toEqual([{ value: "get disabled", label: "disabled" }]);
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
  await h.command("get example");
  expect(h.notifications.at(-1)).toContain("disabled");
  await h.command("enable example");
  expect(h.notifications.at(-1)).toContain("enabled in global configuration");
  expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", other]);
  await h.command("get example");
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
  await h.command("get example");
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

test("cancelled reloads do not replace the current configuration", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await writeFile(join(h.directory, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  h.ctx.signal = AbortSignal.abort();
  await h.command("reload");
  expect(h.notifications.at(-1)).toContain("cancelled");
  await h.command("get example");
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
  expect(result.details.rows[0]).toMatchObject({
    label: "example",
    state: "failed",
  });
  expect(result.details.rows[0].inlineDescription).not.toContain("[secret_lookup_failed]");
  expect(result.details.rows[0].inlineDescription).not.toStartWith(":");
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
  expect(cancelled.details.rows[0].label).toBe("Cancelled");
  expect(JSON.stringify(cancelled.content)).toContain("not replayed");
  expect(JSON.stringify(cancelled)).not.toContain("private-token");
});
