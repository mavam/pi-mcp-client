import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const document = (mcpServers: object) => JSON.stringify({ mcpServers });
const choose = (_title: string, choices: string[]) => choices.find((choice) => /^(Add |Replace |Override )/u.test(choice)) ??
  choices.find((choice) => ["Continue", "Next page", "Continue to confirmation", "Skip"].includes(choice));

async function host(configuration = document({})) {
  const directory = await mkdtemp(join(tmpdir(), "mcp-import-ui-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const destination = join(directory, "mcp.json");
  const source = join(directory, "import.json");
  await writeFile(destination, configuration);
  const hooks = new Map<string, any>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const dialogs: string[] = [];
  let active = ["mcp_tools", "unrelated"];
  let credentials = 0;
  let messages = 0;
  extension({
    registerTool: () => {}, registerMessageRenderer: () => {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => hooks.set(name, handler),
    getActiveTools: () => active, getAllTools: () => [],
    setActiveTools: (names: string[]) => { active = names; },
    sendMessage: () => { messages++; }, appendEntry: () => { messages++; },
  } as unknown as ExtensionAPI, { agentDir: directory, credentialStore: async () => { credentials++; throw new Error("unexpected credential access"); } });
  const ui = {
    select: async (title: string, choices: string[], _options?: { signal: AbortSignal }): Promise<string | undefined> => choose(title, choices),
    confirm: async (_title: string, _message: string, _options?: { signal: AbortSignal }): Promise<boolean> => true,
    input: async (_title: string, _placeholder?: string, _options?: { signal: AbortSignal }): Promise<string | undefined> => undefined,
  };
  const ctx = {
    cwd: directory, hasUI: true, mode: "rpc", signal: new AbortController().signal,
    isProjectTrusted: () => false, isIdle: () => true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (text: string) => notifications.push(text),
      select: (title: string, choices: string[], options: { signal: AbortSignal }) => {
        dialogs.push(title, ...choices); return ui.select(title, choices, options);
      },
      confirm: (title: string, message: string, options: { signal: AbortSignal }) => {
        dialogs.push(title, message); return ui.confirm(title, message, options);
      },
      input: (title: string, placeholder: string, options: { signal: AbortSignal }) => {
        dialogs.push(title, placeholder); return ui.input(title, placeholder, options);
      },
    },
  };
  await hooks.get("session_start")({}, ctx);
  cleanup.push(() => hooks.get("session_shutdown")({}, ctx));
  return { ctx, ui, hooks, source, destination, directory, notifications, dialogs,
    active: () => active, credentials: () => credentials, messages: () => messages,
    command: (input = `import --scope global ${JSON.stringify(source)}`) => commands.get("mcp").handler(input, ctx),
  };
}

test("imports review source settings and save only accepted definitions without execution or secret disclosure", async () => {
  const h = await host();
  const marker = join(h.directory, "must-not-exist");
  await writeFile(h.source, JSON.stringify({ settings: "private-setting", mcpServers: {
    local: { command: "private-command", args: ["private-arg"], env: { TOKEN: `!touch ${marker}` } },
    remote: { url: "https://example.com/private-url", headers: { Authorization: "private-token" } },
    blocked: { command: "private-command", autoApprove: ["private-value"] },
  } }));
  const sourceBefore = await readFile(h.source, "utf8");
  await h.command();
  const saved = JSON.parse(await readFile(h.destination, "utf8"));
  expect(Object.keys(saved.mcpServers)).toEqual(["local", "remote"]);
  expect(saved.mcpServers.remote.headers.Authorization).toBe("private-token");
  expect(saved.mcpServers.local.env.TOKEN).toBe(`$!touch ${marker}`);
  expect(h.dialogs.join("\n")).toContain("other top-level setting");
  expect(h.dialogs.join("\n")).toContain("unsupported server field");
  expect(h.dialogs.join("\n")).toContain("inline credentials");
  expect(h.dialogs.join("\n")).toContain("Relative paths use Pi's working directory");
  expect([...h.dialogs, ...h.notifications].join("\n")).not.toContain("private-");
  expect(await readFile(h.source, "utf8")).toBe(sourceBefore);
  expect(h.notifications.at(-1)).toContain("Imported 2 server(s)");
  expect(h.active()).toEqual(["mcp_tools", "unrelated"]);
  expect(h.credentials()).toBe(0);
  expect(h.messages()).toBe(0);
  await expect(stat(marker)).rejects.toThrow();
  await h.command("get local");
  expect(h.notifications.at(-1)).toContain("disconnected");
});

test("conflicts offer explicit replacement, renaming, and scope precedence without credential merging", async () => {
  const h = await host(document({ existing: { url: "https://old.example", headers: { Authorization: "old-private-token" } } }));
  h.ctx.isProjectTrusted = () => true;
  await writeFile(join(h.directory, ".mcp.json"), document({ existing: { command: "project-command" } }));
  await h.command("reload");
  await writeFile(h.source, document({ existing: { url: "https://new.example" } }));
  await h.command();
  expect(h.dialogs).toContain("Replace global definition (project stays effective)");
  expect(JSON.parse(await readFile(h.destination, "utf8")).mcpServers.existing).toEqual({ url: "https://new.example" });
  await h.command("get existing");
  expect(h.notifications.at(-1)).toContain("Transport: stdio");
  let renamed = false;
  h.ui.select = async (title, choices) => {
    if (choices.includes("Choose a different name") && !renamed) { renamed = true; return "Choose a different name"; }
    return choose(title, choices);
  };
  h.ui.input = async () => "renamed";
  await h.command();
  expect(JSON.parse(await readFile(h.destination, "utf8")).mcpServers.renamed).toEqual({ url: "https://new.example" });
  expect(h.credentials()).toBe(0);
});

test("invalid source names require a new name and duplicate selected destinations cannot overwrite", async () => {
  const h = await host();
  await writeFile(h.source, document({ "\u001b[31mprivate-name": { command: "node" }, chosen: { command: "other" } }));
  let renamed = false;
  h.ui.select = async (title, choices) => {
    if (title.includes("requires a new name") && !renamed) { renamed = true; return "Choose a different name"; }
    return choose(title, choices);
  };
  h.ui.input = async () => "chosen";
  await h.command();
  expect(JSON.parse(await readFile(h.destination, "utf8")).mcpServers).toEqual({ chosen: { command: "node" } });
  expect(h.dialogs.join("\n")).toContain("already selected");
  expect(h.dialogs.join("\n")).not.toContain("private-name");
});

for (const boundary of ["preview", "review", "confirmation", "unexpected response"])
  test(`cancelling at ${boundary} leaves source and destination unchanged`, async () => {
    const h = await host();
    await writeFile(h.source, document({ docs: { url: "https://example.com" } }));
    h.ui.select = async (title, choices) => {
      if ((boundary === "preview" && title.startsWith("Import preview")) ||
          (boundary === "review" && title.startsWith("Review import"))) return undefined;
      if (boundary === "unexpected response") return "unexpected-private-response";
      return choose(title, choices);
    };
    h.ui.confirm = async () => boundary !== "confirmation";
    const before = await readFile(h.destination, "utf8");
    await h.command();
    expect(await readFile(h.destination, "utf8")).toBe(before);
    expect(h.notifications.at(-1)).toContain("cancelled");
    expect(h.messages()).toBe(0);
  });

test("multiple review pages precede final confirmation and skipped entries stay absent", async () => {
  const h = await host();
  await writeFile(h.source, document(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`server${i}`, { command: "node" }]))));
  h.ui.select = async (title, choices) => title.includes("server8 · stdio") && title.startsWith("Import preview") ? "Skip" : choose(title, choices);
  await h.command();
  expect(Object.keys(JSON.parse(await readFile(h.destination, "utf8")).mcpServers)).toHaveLength(8);
  expect(h.dialogs.some((title) => title.startsWith("Review import 1/2"))).toBe(true);
  expect(h.dialogs.some((title) => title.startsWith("Review import 2/2"))).toBe(true);
});

test("a destination edit during confirmation rejects the whole stale preview", async () => {
  const h = await host();
  await writeFile(h.source, document({ docs: { url: "https://example.com" }, other: { command: "node" } }));
  const concurrent = document({ docs: { command: "concurrent-edit" } });
  h.ui.confirm = async () => { await writeFile(h.destination, concurrent); return true; };
  await h.command();
  expect(h.notifications.at(-1)).toContain("changed since the preview");
  expect(await readFile(h.destination, "utf8")).toBe(concurrent);
});

test("saving uses the reviewed source snapshot rather than rereading changed source content", async () => {
  const h = await host();
  await writeFile(h.source, document({ docs: { command: "reviewed" } }));
  h.ui.confirm = async () => {
    await writeFile(h.source, document({ docs: { command: "unreviewed" } }));
    return true;
  };
  await h.command();
  expect(JSON.parse(await readFile(h.destination, "utf8")).mcpServers.docs.command).toBe("reviewed");
});

for (const interruption of ["session_shutdown", "session_tree", "reload", "trust", "abort", "busy"])
  test(`${interruption} during confirmation prevents all writes`, async () => {
    const h = await host();
    await writeFile(h.source, document({ docs: { command: "node" } }));
    h.ui.confirm = async (_title, _message, options) => {
      if (interruption === "reload") await h.command("reload");
      else if (interruption === "trust") h.ctx.isProjectTrusted = () => true;
      else if (interruption === "abort") controller.abort();
      else if (interruption === "busy") h.ctx.isIdle = () => false;
      else await h.hooks.get(interruption)({}, h.ctx);
      if (["reload", "session_shutdown", "session_tree", "abort"].includes(interruption)) expect(options!.signal.aborted).toBe(true);
      return true;
    };
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const before = await readFile(h.destination, "utf8");
    await h.command();
    expect(await readFile(h.destination, "utf8")).toBe(before);
    expect(h.notifications.at(-1)).not.toContain("Imported");
  });

test("headless imports and untrusted project writes are refused before file access or dialogs", async () => {
  const h = await host();
  h.ctx.hasUI = false;
  await expect(h.command()).rejects.toThrow("interactive session");
  h.ctx.hasUI = true;
  await h.command(`import --scope project ${JSON.stringify(h.source)}`);
  expect(h.notifications.at(-1)).toContain("trusted project");
  expect(h.dialogs).toEqual([]);
  expect(h.credentials()).toBe(0);
});

test("the source cannot be overwritten and concurrent import dialogs are refused", async () => {
  const h = await host(document({ docs: { command: "node" } }));
  await h.command(`import --scope global ${JSON.stringify(h.destination)}`);
  expect(h.notifications.at(-1)).toContain("same file");
  await writeFile(h.source, document({ other: { command: "node" } }));
  let attempted = false;
  h.ui.select = async (title, choices) => {
    if (!attempted) {
      attempted = true;
      await h.command();
      expect(h.notifications.at(-1)).toContain("already open");
    }
    return choose(title, choices);
  };
  await h.command();
  expect(h.notifications.at(-1)).toContain("Imported 1");
});
