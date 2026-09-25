import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

interface Options {
  answers?: (string | undefined)[];
  hasUI?: boolean;
  piTrusted?: boolean;
  piResources?: boolean;
  settings?: object;
  saved?: "project" | "parent" | "distrusted";
}

/** A bare project folder, which Pi trusts implicitly, with a planted `.mcp.json`. */
async function host(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-trust-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const marker = join(root, "spawned");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
    planted: { command: "/bin/sh", args: ["-c", `touch ${JSON.stringify(marker)}`] },
  } }));
  if (options.piResources) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), "{}");
  }
  if (options.settings) await writeFile(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  const store = new ProjectTrustStore(agentDir);
  if (options.saved) store.set(options.saved === "parent" ? root : cwd, options.saved !== "distrusted");
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const dialogs: string[] = [];
  const answers = [...(options.answers ?? [])];
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer: () => {}, registerEntryRenderer: () => {},
    on: (name: string, handler: any) => hooks.set(name, handler),
    getActiveTools: () => ["mcp_tools"], getAllTools: () => [...tools.values()], setActiveTools: () => {},
    sendMessage: () => {}, appendEntry: () => {},
  } as unknown as ExtensionAPI, { agentDir, credentialStore: async () => { throw new Error("unexpected credential access"); } });
  const ctx = {
    cwd, hasUI: options.hasUI ?? true, mode: "tui", signal: undefined as AbortSignal | undefined,
    isProjectTrusted: () => options.piTrusted ?? true, isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (text: string) => notifications.push(text),
      select: async (title: string, choices: string[]) => {
        dialogs.push(title);
        expect(choices).toEqual(["Trust", "Trust (this session only)", "Do not trust", "Do not trust (this session only)"]);
        return answers.shift();
      },
    },
  };
  await hooks.get("session_start")({}, ctx);
  cleanup.push(() => hooks.get("session_shutdown")({}, ctx));
  return {
    ctx, cwd, root, marker, store, dialogs, notifications,
    /** Whether the model-facing directory includes the project server. */
    loaded: () => JSON.stringify(hooks.get("before_agent_start")({ systemPrompt: "" }) ?? "").includes("planted"),
    command: (input: string) => commands.get("mcp").handler(input, ctx),
    search: () => tools.get("mcp_tools").execute("id", { query: "planted" }, undefined, undefined, ctx),
  };
}

test("headless sessions ignore project servers in folders Pi trusts implicitly", async () => {
  const h = await host({ hasUI: false });
  expect(h.loaded()).toBe(false);
  await h.search();
  await expect(stat(h.marker)).rejects.toThrow();
  expect(h.store.get(h.cwd)).toBeNull();
  await expect(h.command("add --scope project docs https://docs.example/mcp")).rejects.toThrow("run /trust");
});

for (const [answer, trusted, saved] of [
  ["Trust", true, true],
  ["Trust (this session only)", true, null],
  ["Do not trust", false, false],
  ["Do not trust (this session only)", false, null],
] as const)
  test(`the trust prompt applies "${answer}"`, async () => {
    const h = await host({ answers: [answer] });
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]).toContain(h.cwd);
    expect(h.dialogs[0]).toContain("run local commands");
    expect(h.loaded()).toBe(trusted);
    expect(h.store.get(h.cwd)).toBe(saved);
    expect(h.notifications).toEqual([]);
    await h.command("reload");
    expect(h.dialogs).toHaveLength(1);
    expect(h.loaded()).toBe(trusted);
  });

test("cancelling the prompt ignores project servers until reload asks again", async () => {
  const h = await host({ answers: [undefined, "Trust"] });
  expect(h.loaded()).toBe(false);
  expect(h.notifications.at(-1)).toContain("Run /trust");
  expect(h.store.get(h.cwd)).toBeNull();
  await h.command("reload");
  expect(h.dialogs).toHaveLength(2);
  expect(h.loaded()).toBe(true);
});

test("saved decisions and Pi's default project trust apply without asking", async () => {
  for (const [options, trusted] of [
    [{ saved: "project" }, true],
    [{ saved: "parent" }, true],
    [{ saved: "distrusted" }, false],
    [{ settings: { defaultProjectTrust: "always" } }, true],
    [{ settings: { defaultProjectTrust: "never" } }, false],
    [{ saved: "project", settings: { defaultProjectTrust: "never" } }, true],
  ] as const) {
    const h = await host(options);
    expect(h.dialogs).toEqual([]);
    expect(h.loaded()).toBe(trusted);
    expect(h.notifications).toHaveLength(trusted ? 0 : 1);
  }
});

test("a saved decision made during the session applies on reload", async () => {
  const h = await host({ hasUI: false });
  expect(h.loaded()).toBe(false);
  h.store.set(h.cwd, true);
  await h.command("reload");
  expect(h.loaded()).toBe(true);
});

test("Pi's own decision applies to folders with Pi project resources or an explicit refusal", async () => {
  for (const [options, trusted] of [
    [{ piResources: true, piTrusted: true }, true],
    [{ piResources: true, piTrusted: false }, false],
    [{ saved: "project", piTrusted: false }, false],
  ] as const) {
    const h = await host(options);
    expect(h.dialogs).toEqual([]);
    expect(h.loaded()).toBe(trusted);
    expect(h.notifications).toEqual([]);
  }
});
