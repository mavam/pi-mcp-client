import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint, loadConfig, parseConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mcp-config-"));
  directories.push(directory);
  const agentDir = join(directory, "agent");
  const cwd = join(directory, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  return { agentDir, cwd, put };
}

test("explicit and inferred transports normalize to the same identity", () => {
  for (const [type, fields] of [
    ["stdio", { command: "node", args: ["server.js"], env: { KEY: "${KEY}" } }],
    ["http", { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }],
  ] as const) {
    const input = { mcpServers: { example: { type, ...fields } } };
    const explicit = parseConfig(input);
    const inferred = parseConfig({ mcpServers: { example: fields } });
    expect(explicit).toEqual(inferred);
    expect(fingerprint(explicit)).toBe(fingerprint(inferred));
    expect(input.mcpServers.example.type).toBe(type);
  }
});

test("rejects unsupported transports, conflicting definitions, and invalid inline options", () => {
  for (const entry of [
    { type: "http", command: "node" },
    { type: "stdio", url: "https://example.com/mcp" },
    { type: "sse", url: "https://example.com/sse" },
    { type: "streamable-http", url: "https://example.com/mcp" },
    { type: null, command: "node" },
    { type: 1, command: "node" },
    { type: "http" },
    { type: "stdio", command: "node", url: "https://example.com/mcp" },
    { command: "node", oauth: true },
    { url: "https://example.com/mcp", oauth: "yes" },
    { command: "node", includeTools: [1] },
    { command: "node", excludeTools: "delete_*" },
    { command: "node", disabled: "yes" },
    { command: "node", description: "" },
    { command: "node", timeoutMs: -1 },
    { command: "node", protocol: "unknown" },
    { disabled: true },
  ]) expect(() => parseConfig({ mcpServers: { example: entry } })).toThrow();
});

test("all client options live directly in the server definition", async () => {
  const { agentDir, cwd, put } = await fixture();
  const fields = {
    url: "https://example.com/mcp",
    oauth: true,
    disabled: false,
    description: "Docs",
    includeTools: ["get_*"],
    excludeTools: ["get_secret"],
    timeoutMs: 1000,
    protocol: "auto" as const,
  };
  const document = { mcpServers: { docs: { type: "http", ...fields } } };
  await put(join(agentDir, "mcp.json"), document);
  expect(parseConfig(document).docs).toEqual(fields);
  expect((await loadConfig(agentDir, cwd, true)).docs).toEqual(fields);
  const parsed = parseConfig(document);
  parsed.docs.includeTools!.push("other");
  expect(document.mcpServers.docs.includeTools).toEqual(["get_*"]);
});

test("project definitions replace connections and options in full", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), {
    mcpServers: {
      docs: {
        url: "https://global.example/mcp",
        headers: { Authorization: "global-secret" },
        description: "Documentation",
        timeoutMs: 2000,
        includeTools: ["get_*"],
        excludeTools: ["get_secret"],
        disabled: true,
      },
      local: { command: "node", disabled: true },
    },
  });
  await put(join(cwd, ".mcp.json"), {
    mcpServers: {
      docs: { type: "http", url: "https://project.example/mcp", timeoutMs: 1000, includeTools: [] },
    },
  });
  const config = await loadConfig(agentDir, cwd, true);
  expect(config.docs).toEqual({
    url: "https://project.example/mcp", timeoutMs: 1000, includeTools: [],
  });
  expect(config.local).toEqual({ command: "node", disabled: true });
});

test("untrusted projects cannot override connections or options", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), {
    mcpServers: { docs: { url: "https://global.example/mcp", disabled: true } },
  });
  await put(join(cwd, ".mcp.json"), { invalid: "must not be parsed", pi: {} });
  expect((await loadConfig(agentDir, cwd, false)).docs).toEqual({
    url: "https://global.example/mcp", disabled: true,
  });
});

test("removed pi sections fail explicitly rather than silently losing restrictions", async () => {
  const { agentDir, cwd, put } = await fixture();
  for (const pi of [null, {}, { servers: { docs: { includeTools: [] } } }]) {
    const document = { mcpServers: { docs: { url: "https://example.com/mcp" } }, pi };
    expect(() => parseConfig(document)).toThrow("Put server options directly in mcpServers.<server>");
    await put(join(agentDir, "mcp.json"), document);
    await expect(loadConfig(agentDir, cwd, true)).rejects.toThrow("pi section is not supported");
  }
  await put(join(agentDir, "mcp.json"), { mcpServers: {} });
  await put(join(cwd, ".mcp.json"), { mcpServers: {}, pi: {} });
  await expect(loadConfig(agentDir, cwd, true)).rejects.toThrow("pi section is not supported");
});
