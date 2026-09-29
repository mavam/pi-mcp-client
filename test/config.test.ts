import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fingerprint, loadConfig, parseConfig, setServerDisabled, type ServerConfig } from "../src/config.js";

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
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const put = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
  return { agentDir, cwd, put };
}

test("toggles modify only the effective source and preserve unresolved values", async () => {
  const { agentDir, cwd, put } = await fixture();
  const global = { mcpServers: { docs: { command: "global", enabled: false }, other: { command: "other" } } };
  const project = { metadata: "preserved", mcpServers: {
    docs: { type: "stdio", command: "${MISSING_COMMAND}", env: { KEY: "!secret-command" } },
  } };
  await put(join(agentDir, "mcp.json"), global);
  await put(join(cwd, ".pi", "mcp.json"), project);
  const update = await setServerDisabled(agentDir, cwd, true, "docs", true, () => {});
  expect(update.scope).toBe("project");
  expect(update.config.docs.disabled).toBe(true);
  expect(JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"))).toEqual(global);
  expect(JSON.parse(await readFile(join(cwd, ".pi", "mcp.json"), "utf8"))).toEqual({
    ...project, mcpServers: { docs: { ...project.mcpServers.docs, enabled: false } },
  });
  const fallback = await setServerDisabled(agentDir, cwd, true, "other", true, () => {});
  expect(fallback.scope).toBe("global");
  expect((await loadConfig(agentDir, cwd, true)).other.disabled).toBe(true);
  // Untrusted project files must not even be parsed.
  await writeFile(join(cwd, ".pi", "mcp.json"), "invalid secret JSON");
  expect((await setServerDisabled(agentDir, cwd, false, "docs", false, () => {})).scope).toBe("global");
  expect(await readFile(join(cwd, ".pi", "mcp.json"), "utf8")).toBe("invalid secret JSON");
});

test("toggles preserve symlinks and permissions and serialize concurrent updates", async () => {
  const { agentDir, cwd, put } = await fixture();
  const target = join(agentDir, "actual.json");
  await put(target, { mcpServers: { a: { command: "node" }, b: { command: "node" } } });
  await chmod(target, 0o640);
  await symlink(target, join(agentDir, "mcp.json"));
  await Promise.all(["a", "b"].map((name) => setServerDisabled(agentDir, cwd, false, name, true, () => {})));
  expect((await lstat(join(agentDir, "mcp.json"))).isSymbolicLink()).toBe(true);
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  const config = await loadConfig(agentDir, cwd, false);
  expect(config.a.disabled).toBe(true);
  expect(config.b.disabled).toBe(true);
  expect((await readdir(agentDir)).sort()).toEqual(["actual.json", "mcp.json"]);
});

test("global and project aliases of the same file do not deadlock", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), { mcpServers: { docs: { command: "node" } } });
  await symlink(join(agentDir, "mcp.json"), join(cwd, ".pi", "mcp.json"));
  await setServerDisabled(agentDir, cwd, true, "docs", true, () => {});
  expect((await loadConfig(agentDir, cwd, true)).docs.disabled).toBe(true);
});

test("failed validation and missing servers never change configuration", async () => {
  const { agentDir, cwd, put } = await fixture();
  const path = join(agentDir, "mcp.json");
  await put(path, { mcpServers: { docs: { command: "node", enabled: false } } });
  const before = await readFile(path, "utf8");
  await expect(setServerDisabled(agentDir, cwd, false, "missing", false, () => {})).rejects.toThrow();
  await expect(setServerDisabled(agentDir, cwd, false, "docs", false, () => { throw new Error("invalid"); })).rejects.toThrow("invalid");
  expect(await readFile(path, "utf8")).toBe(before);
  let validations = 0;
  await expect(setServerDisabled(agentDir, cwd, false, "docs", false, () => {
    if (++validations > 1) throw new Error("cancelled");
  })).rejects.toThrow("cancelled");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readdir(agentDir)).toEqual(["mcp.json"]);
});

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
    { type: null, command: "node" },
    { type: 1, command: "node" },
    { type: "http" },
    { type: "stdio", command: "node", url: "https://example.com/mcp" },
    { command: "node", oauth: {} },
    { url: "https://example.com/mcp", oauth: "yes" },
    { url: "https://example.com/mcp", oauth: { unknown: 1 } },
    { command: "node", toolExposure: { search: "sometimes" } },
    { command: "node", toolExposure: [] },
    { command: "node", exposure: "loud" },
    { command: "node", enabled: "yes" },
    { command: "node", description: "" },
    { command: "node", timeout: -1 },
    { command: "node", protocol: "unknown" },
    { enabled: false },
  ]) expect(() => parseConfig({ mcpServers: { example: entry } })).toThrow();
});

test("all client options live directly in the server definition", async () => {
  const { agentDir, cwd, put } = await fixture();
  const fields = {
    url: "https://example.com/mcp",
    oauth: { clientId: "client", scope: "read write", callbackPort: 12345, dpop: true },
    enabled: true,
    description: "Docs",
    exposure: "hidden",
    toolExposure: { "get_*": "codemode", get_secret: "hidden" },
    timeout: 1,
    startupTimeout: 2.5,
    toolTimeout: 30,
    protocol: "auto" as const,
  };
  const normalized: ServerConfig = {
    url: "https://example.com/mcp",
    oauthClientId: "client",
    oauthScopes: ["read", "write"],
    oauthCallbackPort: 12345,
    oauthDpop: true,
    description: "Docs",
    exposure: "hidden",
    toolExposure: { "get_*": "codemode", get_secret: "hidden" },
    timeoutMs: 1000,
    startupTimeoutMs: 2500,
    toolTimeoutMs: 30_000,
    protocol: "auto",
  };
  const document = { mcpServers: { docs: { type: "streamable-http", ...fields } } };
  await put(join(agentDir, "mcp.json"), document);
  expect(parseConfig(document).docs).toEqual(normalized);
  expect((await loadConfig(agentDir, cwd, true)).docs).toEqual(normalized);
  const parsed = parseConfig(document);
  parsed.docs.toolExposure!.other = "hidden";
  expect(document.mcpServers.docs.toolExposure).toEqual({ "get_*": "codemode", get_secret: "hidden" });
});

test("project definitions replace connections and options in full", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), {
    mcpServers: {
      docs: {
        url: "https://global.example/mcp",
        headers: { Authorization: "global-secret" },
        description: "Documentation",
        timeout: 2,
        toolExposure: { get_secret: "hidden" },
        enabled: false,
      },
      local: { command: "node", enabled: false },
    },
  });
  await put(join(cwd, ".pi", "mcp.json"), {
    mcpServers: {
      docs: { type: "http", url: "https://project.example/mcp", timeout: 1, exposure: "hidden" },
    },
  });
  const config = await loadConfig(agentDir, cwd, true);
  expect(config.docs).toEqual({
    url: "https://project.example/mcp", timeoutMs: 1000, exposure: "hidden",
  });
  expect(config.local).toEqual({ command: "node", disabled: true });
});

test("untrusted projects cannot override connections or options", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), {
    mcpServers: { docs: { url: "https://global.example/mcp", enabled: false } },
  });
  await put(join(cwd, ".pi", "mcp.json"), { invalid: "must not be parsed", pi: {} });
  expect((await loadConfig(agentDir, cwd, false)).docs).toEqual({
    url: "https://global.example/mcp", disabled: true,
  });
});

test("removed pi sections fail explicitly rather than silently losing restrictions", async () => {
  const { agentDir, cwd, put } = await fixture();
  for (const pi of [null, {}, { servers: { docs: { exposure: "hidden" } } }]) {
    const document = { mcpServers: { docs: { url: "https://example.com/mcp" } }, pi };
    expect(() => parseConfig(document)).toThrow("Put server options directly in mcpServers.<server>");
    await put(join(agentDir, "mcp.json"), document);
    await expect(loadConfig(agentDir, cwd, true)).rejects.toThrow("pi section is not supported");
  }
  await put(join(agentDir, "mcp.json"), { mcpServers: {} });
  await put(join(cwd, ".pi", "mcp.json"), { mcpServers: {}, pi: {} });
  await expect(loadConfig(agentDir, cwd, true)).rejects.toThrow("pi section is not supported");
});

test("invalid servers are skipped and reported without hiding the valid ones", async () => {
  const { agentDir, cwd, put } = await fixture();
  await put(join(agentDir, "mcp.json"), { mcpServers: {
    good: { command: "node" },
    badField: { command: "node", exposure: "loud", env: { KEY: "private-secret" } },
    badOauth: { url: "https://example.com/mcp", oauth: { clientSecret: "private-secret" } },
    _leadingUnderscore: { command: "node" },
    primitive: "private-secret",
  } });
  await expect(loadConfig(agentDir, cwd, true)).rejects.toThrow();
  const problems: string[] = [];
  expect(Object.keys(await loadConfig(agentDir, cwd, true, problems))).toEqual(["good"]);
  expect(problems).toHaveLength(4);
  expect(problems.join("\n")).toContain("invalid exposure for server badField");
  expect(problems.join("\n")).not.toContain("private-secret");
  const update = await setServerDisabled(agentDir, cwd, false, "good", true, () => {});
  expect(update.config.good.disabled).toBe(true);
  expect(update.problems).toHaveLength(4);
  const document = JSON.parse(await readFile(join(agentDir, "mcp.json"), "utf8"));
  expect(Object.keys(document.mcpServers)).toEqual(["good", "badField", "badOauth", "_leadingUnderscore", "primitive"]);
  // A broken file still fails as a whole.
  await put(join(agentDir, "mcp.json"), { servers: {} });
  await expect(loadConfig(agentDir, cwd, true, [])).rejects.toThrow("expected an mcpServers object");
});
