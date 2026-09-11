import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { restoredTools } from "../src/exposure.js";
import { prepareTool } from "../src/catalog.js";
import { preparePrompt } from "../src/prompts.js";
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
  const messages: { message: any; options: any }[] = [];
  const entries: { customType: string; data: any }[] = [];
  const entryRenderers = new Map<string, any>();
  let active = ["mcp_tools"];
  extension(
    {
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerMessageRenderer: () => {},
      registerEntryRenderer: (name: string, renderer: any) => entryRenderers.set(name, renderer),
      appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
      sendMessage: (message: any, options: any) => messages.push({ message, options }),
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
    isIdle: () => true,
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
    messages,
    entries,
    entryRenderers,
    command: (args: string) => commands.get("mcp").handler(args, ctx),
  };
}

test("bare mcp renders transcript snapshots without connecting or sending model messages", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  h.ctx.mode = "tui";
  const notifications = h.notifications.length;
  await h.command("");
  expect(h.entries).toHaveLength(1);
  expect(h.entries[0].customType).toBe("mcp-status");
  expect(h.entries[0].data).toEqual({
    servers: [{ name: "example", state: "disconnected", catalogSize: undefined, error: undefined }],
    loaded: [],
  });
  expect(h.entryRenderers.has("mcp-status")).toBe(true);
  expect(h.notifications).toHaveLength(notifications);
  expect(h.messages).toHaveLength(0);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  expect([...h.tools.keys()]).toEqual(["mcp_tools"]);

  await h.execute("mcp_tools", { activate: ["example.echo"] });
  await h.command("");
  expect(h.entries.at(-1)?.data.loaded).toEqual([["example", 1]]);
  expect(h.entries.at(-1)?.data.servers[0].state).toBe("connected");
  expect(h.entries[0].data.servers[0].state).toBe("disconnected");
});

test("removed status aliases fail without connecting or rendering a panel", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  h.ctx.mode = "tui";
  for (const action of ["list", "status", "list example", "status example"]) {
    await h.command(action);
    expect(h.notifications.at(-1)).toContain("/mcp");
    expect(h.notifications.at(-1)).toMatch(/Usage:|Unknown MCP command/);
  }
  const completions = h.commands.get("mcp").getArgumentCompletions("");
  expect(completions.map((item: { value: string }) => item.value)).not.toContain("list");
  expect(completions.map((item: { value: string }) => item.value)).not.toContain("status");
  expect(h.entries).toHaveLength(0);
  expect(h.messages).toHaveLength(0);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
  await h.command("");
  expect(h.entries[0].data.servers[0].state).toBe("disconnected");
});

test("RPC status stays plain text and non-UI modes do not emit panels", async () => {
  const h = await host(JSON.stringify({ mcpServers: {} }));
  h.ctx.mode = "rpc";
  await h.command("");
  expect(h.notifications.at(-1)).toContain("No MCP servers configured.");
  expect(h.notifications.at(-1)).not.toContain("\x1b");
  expect(h.entries).toHaveLength(0);
  const notifications = h.notifications.length;
  h.ctx.hasUI = false;
  for (const mode of ["print", "json"]) {
    h.ctx.mode = mode;
    await h.command("");
  }
  expect(h.notifications).toHaveLength(notifications);
  expect(h.entries).toHaveLength(0);
  expect(h.messages).toHaveLength(0);
});

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
    private: { url: "https://example.com/mcp", disabled: true },
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
    example: { url: "https://oauth.example/mcp" },
    alias: { url: "https://oauth.example/mcp", disabled: true },
    external: { url: "https://external.example/mcp", headers: { Authorization: "!never-execute" } },
  } });
  const h = await host(configuration, [], async () => store);
  const provider = new OAuthProvider({ server: "alias", url: "https://oauth.example/mcp" }, store);
  provider.saveTokens({ access_token: "private-token", token_type: "Bearer" });
  await h.command("get alias");
  expect(h.notifications.at(-1)).toContain("stored tokens (validity not checked)");
  expect(h.notifications.at(-1)).not.toContain("private-token");
  const disconnect = spyOn(McpRuntime.prototype, "disconnect");
  const discover = spyOn(McpRuntime.prototype, "discover").mockResolvedValue({
    tools: [prepareTool("example", "fixture", { name: "echo", inputSchema: { type: "object" } })],
    resources: [], diagnostics: [], unavailable: [], warnings: [],
  });
  try {
    h.setActiveTools(["mcp_tools", "unrelated"]);
    await h.execute("mcp_tools", { activate: ["example.echo"] });
    expect(h.activeTools()).toContain("mcp__example__echo");
    await h.command("logout alias");
    expect(disconnect).toHaveBeenCalledWith(["alias"]);
    expect(record).toBeNull();
    expect(h.notifications.at(-1)).toContain("local OAuth credentials removed");
    expect(h.notifications.at(-1)).toContain("Remote revocation could not be confirmed");
    expect(h.activeTools()).toEqual(["mcp_tools", "unrelated", "mcp__example__echo"]);
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

test("get and logout isolate names sharing a URL and configured client ID", async () => {
  const stores = new Map<string, { read: () => string | null; write: (value: string) => void; remove: () => void }>();
  const url = "https://clients.example/mcp";
  for (const server of ["first", "second"]) {
    let record: string | null = null;
    const store = { read: () => record, write: (value: string) => { record = value; }, remove: () => { record = null; } };
    new OAuthProvider({ server, url, clientId: "shared-client" }, store).saveTokens({ access_token: "private-token", token_type: "Bearer", issuer: "https://issuer.example" });
    stores.set(server, store);
  }
  const h = await host(JSON.stringify({ mcpServers: {
    first: { url, oauthClientId: "shared-client", disabled: true },
    second: { url, oauthClientId: "shared-client" },
  } }), [], async (identity) => {
    expect(identity.url).toBe(url);
    expect(identity.clientId).toBe("shared-client");
    return stores.get(identity.server)!;
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
  const h = await host(JSON.stringify({ mcpServers: { example: { url: "https://oauth.example/mcp" } } }), [],
    async () => ({ read: () => null, write: () => {}, remove: () => { throw new Error("private-keyring-error"); } }));
  await h.command("logout example");
  expect(h.notifications.at(-1)).not.toContain("credentials removed");
  expect(h.notifications.at(-1)).not.toContain("private-keyring-error");
});

test("login refuses header authentication, disabled servers, and headless use without changing configuration", async () => {
  for (const definition of [
    { url: "https://example.com/mcp", headers: { aUtHoRiZaTiOn: "!never-execute" } },
    { url: "https://example.com/mcp", disabled: true },
    { url: "https://example.com/mcp" },
  ]) {
    let accesses = 0;
    const configuration = JSON.stringify({ mcpServers: { example: definition } });
    const h = await host(configuration, [], async () => { accesses++; throw new Error("unexpected access"); });
    if (!definition.headers && !definition.disabled) {
      h.ctx.hasUI = false;
      await expect(h.command("login example")).rejects.toThrow("interactive session");
    } else {
      await h.command("login example");
      expect(h.notifications.at(-1)).toContain(definition.headers ? "Authorization header" : "Disabled servers");
    }
    expect(accesses).toBe(0);
    expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(configuration);
  }
});

test("login uses the effective definition without writing global or project files", async () => {
  for (const trusted of [true, false]) {
    const global = JSON.stringify({ mcpServers: { example: { url: "https://global.example/mcp" } } });
    const project = trusted ? JSON.stringify({ mcpServers: { example: { url: "https://project.example/mcp" } } }) : "untrusted invalid JSON";
    const accessed: string[] = [];
    const h = await host(global, [], async (identity) => {
      expect(identity.server).toBe("example");
      accessed.push(identity.url);
      throw new Error("fixture: stop before network access");
    });
    await writeFile(join(h.directory, ".mcp.json"), project);
    h.ctx.isProjectTrusted = () => trusted;
    await h.command("reload");
    await h.command("login example");
    expect(accessed).toEqual([trusted ? "https://project.example/mcp" : "https://global.example/mcp"]);
    expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(global);
    expect(await readFile(join(h.directory, ".mcp.json"), "utf8")).toBe(project);
  }
});

test("manual login validates syntax and refuses non-interactive use before credentials", async () => {
  let accesses = 0;
  const h = await host(JSON.stringify({ mcpServers: { example: { url: "https://example.com/mcp" } } }), [], async () => {
    accesses++;
    throw new Error("unexpected credential access");
  });
  for (const input of ["login example --unknown", "login example --no-browser extra", "login example --no-browser --no-browser", "login --no-browser example"]) {
    await h.command(input);
    expect(h.notifications.at(-1)).toContain("Usage:");
  }
  h.ctx.hasUI = false;
  await expect(h.command("login example --no-browser")).rejects.toThrow("interactive session");
  expect(accesses).toBe(0);
  expect(h.commands.get("mcp").getArgumentCompletions("login example --no"))
    .toEqual([{ value: "login example --no-browser", label: "--no-browser" }]);
});

for (const configured of [true, false]) for (const outcome of ["success", "cancel", "shutdown"] as const) {
  test(`manual login keeps callbacks in dialogs and handles ${outcome} (pre-registered client: ${configured})`, async () => {
    let base = "";
    let record: string | null = null;
    let tokenRequests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      if (path === "/.well-known/oauth-authorization-server")
        return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          response_types_supported: ["code"], registration_endpoint: `${base}/register`, token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"] });
      if (path === "/register") return Response.json({ ...await request.json() as object, client_id: "dynamic-public" }, { status: 201 });
      if (path === "/token") {
        tokenRequests++;
        return Response.json({ access_token: "private-token", token_type: "Bearer" });
      }
      return new Response("Not found", { status: 404 });
    } });
    base = `http://127.0.0.1:${server.port}`;
    cleanup.push(async () => { await server.stop(true); });
    const h = await host(JSON.stringify({ mcpServers: { example: { url: `${base}/mcp`, ...(configured ? { oauthClientId: "public", oauthScopes: ["read"], oauthCallbackPort: 19848 } : {}) } } }), [], async () => ({
      read: () => record, write: (value) => { record = value; }, remove: () => { record = null; },
    }));
    const reconnect = spyOn(McpRuntime.prototype, "reconnect").mockResolvedValue(undefined);
    cleanup.push(async () => reconnect.mockRestore());
    let prompts = 0;
    Object.assign(h.ctx.ui, { input: async (title: string, placeholder: string, options: { signal: AbortSignal }) => {
      prompts++;
      expect(title).toContain(`Requested scopes: ${configured ? "read" : "SDK/server defaults"}`);
      expect(placeholder).toBe("Callback URL");
      if (outcome === "cancel") return undefined;
      if (outcome === "shutdown") {
        await h.hooks.get("session_shutdown")({}, h.ctx);
        expect(options.signal.aborted).toBe(true);
        return undefined;
      }
      const authorization = new URL(title.split("Open this URL in a browser:\n")[1].split("\n")[0]);
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "private-code");
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      return callback.href;
    } });
    const before = await readFile(join(h.directory, "mcp.json"), "utf8");
    await h.command("login example --no-browser");
    expect(await readFile(join(h.directory, "mcp.json"), "utf8")).toBe(before);
    expect(prompts).toBe(1);
    expect(tokenRequests).toBe(outcome === "success" ? 1 : 0);
    expect(reconnect).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(h.notifications.at(-1)).toContain(outcome === "success" ? "login complete" : "cancelled");
    const notifications = h.notifications.join("\n");
    for (const value of ["private-code", "private-token", "/authorize", "state="]) expect(notifications).not.toContain(value);
    expect(h.activeTools()).toEqual(["mcp_tools"]);
  });
}

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
    expect(h.notifications.at(-1)).toContain("HTTP server");
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

test("reads and activation share target rows and distinguish new from active tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const updates: any[] = [];
  const activated = await h.execute("mcp_tools", { activate: ["example.echo", "example.fail"] }, (result) => updates.push(result));
  expect(updates[0].details.rows).toEqual([
    { label: "example · echo", state: "running" },
    { label: "example · fail", state: "running" },
  ]);
  expect(activated.details.rows).toEqual([
    { label: "example · echo", state: "done" },
    { label: "example · fail", state: "done" },
  ]);
  const repeated = await h.execute("mcp_tools", { activate: ["mcp__example__echo", "example.missing"] });
  expect(repeated.details.rows[0]).toEqual({ label: "example · echo", state: "active" });
  expect(repeated.details.rows[1]).toMatchObject({ label: "example · missing", state: "failed" });
  expect(repeated.details.rows[1].inlineDescription).toContain("unknown identifier");
  updates.length = 0;
  const read = await h.execute("mcp_tools", { read: { server: "example", uri: "schema://analytics" } }, (result) => updates.push(result));
  expect(updates[0].details.rows).toEqual([{ label: "example · schema://analytics", state: "running" }]);
  expect(read.details.rows).toEqual([{ label: "example · schema://analytics", state: "done" }]);
  const missing = await h.execute("mcp_tools", { read: { server: "example", uri: "schema://missing" } });
  expect(missing.details.rows[0]).toMatchObject({ label: "example · schema://missing", state: "failed" });
  expect(missing.details.rows[0].inlineDescription).toContain("not found");
});

test("invalid argument combinations fail before any discovery or transport work", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const discover = spyOn(McpRuntime.prototype, "discover");
  const read = spyOn(McpRuntime.prototype, "readResource");
  try {
    for (const args of [
      {}, { query: "echo", activate: ["example.echo"] }, { server: "example" },
      { limit: 5 }, { activate: ["example.echo"], server: "example" },
      { activate: ["example.echo"], limit: 5 }, { activate: [] },
      { activate: Array(51).fill("example.echo") }, { activate: [""] },
      { query: " " }, { query: "echo", limit: 0 }, { query: "echo", extra: true },
      { kind: "all" }, { query: "schema", kind: "invalid" }, { activate: ["example.echo"], kind: "all" },
      { read: { server: "example", template: "schema://{id}" } },
      { read: { server: "example", template: "schema://{id}", arguments: { id: 1 } } },
      { read: { server: "example", template: "schema://{id}", arguments: { id: [1] } } },
      { read: { server: "example", template: "schema://{id}", arguments: { id: {} } } },
      { read: { server: "example", uri: "schema://x", arguments: {} } },
      { read: { server: "example", uri: "schema://x", template: "schema://{id}", arguments: {} } },
      { read: null }, { read: [] }, { read: {} }, { read: { server: "example" } },
      { read: { server: "example", uri: "relative" } }, { read: { server: "example", uri: "schema://x", extra: true } },
      { read: { server: "example", uri: "schema://x" }, query: "schema" },
      { read: { server: "example", uri: "schema://x" }, activate: ["example.echo"] },
      { read: { server: "example", uri: "schema://x" }, server: "example" },
      { read: { server: "example", uri: "schema://x" }, kind: "all" },
      { read: { server: "example", uri: "schema://x" }, limit: 1 },
    ]) {
      const result = await h.execute("mcp_tools", args);
      expect(result.details.failed).toBe(true);
      // The error must identify both legal modes without pinning its prose.
      expect(result.content[0].text).toContain("query");
      expect(result.content[0].text).toContain("activate");
    }
    expect(discover).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(h.activeTools()).toEqual(["mcp_tools"]);
  } finally { discover.mockRestore(); read.mockRestore(); }
});

test("resource discovery and reading work headlessly without tool activation", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  h.ctx.hasUI = false;
  h.setActiveTools(["mcp_tools", "unrelated"]);
  const read = spyOn(McpRuntime.prototype, "readResource");
  try {
    const discovered = await h.execute("mcp_tools", { query: "analytics" });
    expect(discovered.details.candidates).toHaveLength(1);
    expect(discovered.details.candidates[0].kind).toBe("resource");
    expect(JSON.stringify(discovered.content)).not.toContain("events");
    expect(read).not.toHaveBeenCalled();
    const result = await h.execute("mcp_tools", discovered.details.candidates[0].nextCall);
    expect(result.details.resource).toEqual({ server: "example", uri: "schema://analytics" });
    expect(JSON.stringify(result.content)).toContain("events");
    expect(result.details.loaded).toBeUndefined();
    expect(result.details.candidates).toBeUndefined();
    expect(h.activeTools()).toEqual(["mcp_tools", "unrelated"]);
    expect([...h.tools.keys()]).toEqual(["mcp_tools"]);
    expect(restoredTools([{ type: "message", message: { role: "toolResult", toolName: "mcp_tools", details: result.details } } as any])).toEqual([]);
    expect((await h.execute("mcp_tools", { query: "analytics", kind: "tools" })).details.candidates).toEqual([]);
  } finally { read.mockRestore(); }
});

test("template discovery and parameterized reads preserve the native tool set", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  h.ctx.hasUI = false;
  const discovered = await h.execute("mcp_tools", { query: "schema://tables/{table}", kind: "resources" });
  const candidate = discovered.details.candidates[0];
  expect(candidate.kind).toBe("template");
  expect(candidate.variables).toEqual(["table"]);
  expect(candidate.nextCall.read).toEqual({ server: "example", template: "schema://tables/{table}", arguments: {} });
  const result = await h.execute("mcp_tools", { read: { ...candidate.nextCall.read, arguments: { table: "events" } } });
  expect(result.details.rows[0].label).toBe("example · schema://tables/events");
  expect(JSON.stringify(result.content)).toContain("events");
  expect(JSON.stringify(result.content)).toContain("Template:");
  expect(result.details.loaded).toBeUndefined();
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("resource reads that finish after reload do not attach stale content", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  let finish!: () => void;
  const read = spyOn(McpRuntime.prototype, "readResource").mockImplementation(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    return { contents: [{ uri: "schema://analytics", text: "late-content" }] };
  });
  try {
    const pending = h.execute("mcp_tools", { read: { server: "example", uri: "schema://analytics" } });
    await Promise.resolve();
    await h.command("reload");
    finish();
    const result = await pending;
    expect(result.details.failed).toBe(true);
    expect(result.details.diagnostics[0].code).toBe("cancelled");
    expect(JSON.stringify(result.content)).not.toContain("late-content");
  } finally { read.mockRestore(); }
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
    ["reload", "subscriptions", "add", "remove", "import", "enable", "disable", "get", "tools", "prompt", "login", "logout", "reconnect", "refresh", "subscribe", "unsubscribe"]
      .map((value) => ({ value, label: value })),
  );
  expect(complete("to")).toEqual([{ value: "tools", label: "tools" }]);
  expect(complete("tools")).toEqual([{ value: "tools", label: "tools" }]);
  for (const action of ["tools", "prompt", "login", "reconnect", "refresh"]) {
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
  await h.command("");
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

test("bare mcp reports idle and loaded tools without opening connections", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  await h.command("");
  const listing = h.notifications.at(-1)!;
  expect(listing).toContain("○ example");
  expect(listing).toContain("idle");
  expect(listing).not.toContain("unknown catalog tools");
  expect(listing).toContain("Connections open on demand");
  await h.command("  ");
  expect(h.notifications.at(-1)).toBe(listing);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await h.execute("mcp_tools", { activate: ["example.echo"] });
  await h.command("");
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
  await h.command("");
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
  await h.command("");
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

test("resource completions are exclusive, bounded suggestions and never restore tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const complete = { server: "example", template: "schema://tables/{table}", argument: { name: "table", value: "e" } };
  const result = await h.execute("mcp_tools", { complete });
  expect(result.content[0].text).toContain('"values":["events"]');
  expect(result.details.loaded).toBeUndefined();
  expect(result.details.candidates).toBeUndefined();
  expect(result.details.resource).toBeUndefined();
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  for (const other of [{ query: "table" }, { activate: ["example.echo"] }, { read: { server: "example", uri: "schema://analytics" } }, { kind: "resources" }, { limit: 1 }, { server: "example" }]) {
    const invalid = await h.execute("mcp_tools", { complete, ...other });
    expect(invalid.details.failed).toBe(true);
    expect(invalid.content[0].text).toContain("Use exactly one");
  }
  const huge = spyOn(McpRuntime.prototype, "completeResource").mockResolvedValue({ values: ["x".repeat(70_000)], total: 1, hasMore: false });
  try {
    const bounded = await h.execute("mcp_tools", { complete });
    expect(Buffer.byteLength(bounded.content[0].text)).toBeLessThan(53_000);
    expect(bounded.details.fullOutputPath).toBeDefined();
    cleanup.push(() => rm(join(bounded.details.fullOutputPath, ".."), { recursive: true, force: true }));
  } finally { huge.mockRestore(); }
});

test("invalid completions and subscription commands fail before runtime access", async () => {
  const h = await host('{"mcpServers":{"example":{"command":"must-not-execute"}}}');
  const complete = { server: "example", template: "schema://{id}", argument: { name: "id", value: "" } };
  for (const args of [{ complete: null }, { complete, query: "x" }, { complete: { ...complete, arguments: { id: [] } } }, { subscribe: { server: "example", uri: "schema://x" } }]) {
    expect((await h.execute("mcp_tools", args)).details.failed).toBe(true);
  }
  await h.command("subscribe example /etc/passwd");
  expect(h.notifications.at(-1)).toContain("exact absolute URI");
  h.ctx.hasUI = false;
  const subscribe = spyOn(McpRuntime.prototype, "setResourceSubscription");
  try {
    await expect(h.command("subscribe example schema://x")).rejects.toThrow("interactive session");
    expect(subscribe).not.toHaveBeenCalled();
  } finally { subscribe.mockRestore(); }
  h.ctx.hasUI = true;
  await h.command("get example");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("user watches leave snapshots and tools untouched and clear on tree navigation and reload", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const snapshot = await h.execute("mcp_tools", { read: { server: "example", uri: "schema://analytics" } });
  const original = JSON.stringify(snapshot);
  await h.command("subscribe example schema://analytics");
  await Bun.sleep(30);
  expect(h.notifications.some((message) => message.includes("Attached snapshots are unchanged"))).toBe(true);
  await h.command("subscriptions");
  expect(h.notifications.at(-1)).toContain("schema://analytics · changed");
  expect(JSON.stringify(snapshot)).toBe(original);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  await h.hooks.get("session_tree")({}, h.ctx);
  await h.command("subscriptions");
  expect(h.notifications.at(-1)).toBe("No active resource subscriptions.");
  await h.command("subscribe example schema://analytics");
  await h.command("reload");
  await h.command("subscriptions");
  expect(h.notifications.at(-1)).toBe("No active resource subscriptions.");
  await h.command("unsubscribe example schema://analytics");
  expect(h.notifications.at(-1)).toContain("removed");
});

test("prompt commands send a labeled snapshot only after explicit confirmation and never activate tools", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const prompt = preparePrompt("example", "id", { name: "explain", arguments: [{ name: "topic", required: true }] });
  const catalog = spyOn(McpRuntime.prototype, "promptCatalog").mockResolvedValue([prompt]);
  const get = spyOn(McpRuntime.prototype, "getPrompt").mockResolvedValue({ messages: [
    { role: "assistant", content: { type: "text", text: "Snapshot sentinel" } },
  ] });
  cleanup.push(async () => { catalog.mockRestore(); get.mockRestore(); });
  h.ctx.ui.select = async (title, options) => {
    expect(h.messages).toEqual([]);
    return title.includes("Preview") ? "Use prompt" : options.find((option) => option === "Fetch preview");
  };
  await h.command("prompt example explain topic=OAuth");
  expect(get).toHaveBeenCalledTimes(1);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0]).toMatchObject({ message: { customType: "mcp-prompt", display: true, details: { server: "example", name: "explain", count: 1 } }, options: { triggerTurn: true } });
  expect(h.messages[0].message.content).toContain("untrusted server data");
  expect(h.messages[0].message.content).toContain("Snapshot sentinel");
  expect(h.activeTools()).toEqual(["mcp_tools"]);
});

test("the assistant discovers prompt metadata but cannot fetch or run prompts", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const catalog = spyOn(McpRuntime.prototype, "promptCatalog").mockResolvedValue([
    preparePrompt("example", "id", { name: "explain", description: "Explain OAuth" }),
  ]);
  const get = spyOn(McpRuntime.prototype, "getPrompt");
  cleanup.push(async () => { catalog.mockRestore(); get.mockRestore(); });
  const result = await h.execute("mcp_tools", { query: "explain", server: "example", kind: "prompts" });
  expect(result.details.candidates[0]).toMatchObject({ kind: "prompt", command: "/mcp prompt example explain" });
  expect(result.content[0].text).toContain("recommend; do not execute");
  expect(get).not.toHaveBeenCalled();
  expect(h.messages).toEqual([]);
  expect(h.activeTools()).toEqual(["mcp_tools"]);
  const rejected = await h.execute("mcp_tools", { prompt: { server: "example", name: "explain" } });
  expect(rejected.details.failed).toBe(true);
  expect(get).not.toHaveBeenCalled();
});

test("tree navigation while reviewing a prompt discards the pending selection", async () => {
  const h = await host(JSON.stringify({ mcpServers: { example: fixtureServer } }));
  const catalog = spyOn(McpRuntime.prototype, "promptCatalog").mockResolvedValue([
    preparePrompt("example", "id", { name: "explain" }),
  ]);
  const get = spyOn(McpRuntime.prototype, "getPrompt").mockResolvedValue({ messages: [
    { role: "user", content: { type: "text", text: "Don't attach" } },
  ] });
  cleanup.push(async () => { catalog.mockRestore(); get.mockRestore(); });
  h.ctx.ui.select = async (title) => {
    if (!title.includes("Preview")) return "Fetch preview";
    await h.hooks.get("session_tree")({}, h.ctx);
    return "Use prompt";
  };
  await h.command("prompt example explain");
  expect(get).toHaveBeenCalledTimes(1);
  expect(h.messages).toEqual([]);
  expect(h.notifications.at(-1)).toContain("cancelled");
});
