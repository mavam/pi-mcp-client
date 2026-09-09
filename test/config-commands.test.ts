import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandWords, configCommandCompletions, parseConfigCommand } from "../src/config-commands.js";
import { loadConfig, resolveServer, setServerDisabled, updateServerConfig, type Config } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-edit-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const validate = (config: Config) => {
    for (const definition of Object.values(config)) if (!definition.disabled) resolveServer(definition, cwd);
  };
  const run = (command: string, trusted = true, check = validate) =>
    updateServerConfig(agentDir, cwd, trusted, parseConfigCommand(command)!, check);
  return { root, agentDir, cwd, run, validate };
}

test("login enables OAuth in the effective scope without replacing other fields", async () => {
  for (const trusted of [true, false]) {
    const f = await fixture();
    await f.run("add --scope global example https://global.example/mcp");
    await f.run("add --scope project --replace --header 'X-Key: !never-run' example https://project.example/mcp");
    const global = join(f.agentDir, "mcp.json");
    const project = join(f.cwd, ".mcp.json");
    const untouched = trusted ? global : project;
    const before = await readFile(untouched, "utf8");
    const expected = (await loadConfig(f.agentDir, f.cwd, trusted)).example;
    const result = await updateServerConfig(f.agentDir, f.cwd, trusted, { action: "oauth", server: "example", expected }, f.validate);
    expect(result.scope).toBe(trusted ? "project" : "global");
    expect(result.config.example).toEqual({ ...expected, oauth: true });
    expect(await readFile(untouched, "utf8")).toBe(before);
    expect((await loadConfig(f.agentDir, f.cwd, trusted)).example).toEqual(result.config.example);
  }
});

test("login rejects stale definitions and Authorization headers without writing", async () => {
  const f = await fixture();
  await f.run("add --scope global example https://example.com/mcp");
  const expected = (await loadConfig(f.agentDir, f.cwd, false)).example;
  await f.run("add --scope global --replace --header 'aUtHoRiZaTiOn: !never-run' example https://example.com/mcp");
  const path = join(f.agentDir, "mcp.json");
  const before = await readFile(path, "utf8");
  await expect(updateServerConfig(f.agentDir, f.cwd, false, { action: "oauth", server: "example", expected }, f.validate)).rejects.toThrow("configuration changed");
  await expect(updateServerConfig(f.agentDir, f.cwd, false, {
    action: "oauth", server: "example", expected: (await loadConfig(f.agentDir, f.cwd, false)).example,
  }, f.validate)).rejects.toThrow("Authorization header");
  expect(await readFile(path, "utf8")).toBe(before);
});

test("configuration command parsing preserves quoted argv without shell expansion", () => {
  expect(commandWords(`node 'two words' "" "C:\\tools\\server.js" ';' '$(touch marker)' '*.ts' '${"${VALUE}"}'`))
    .toEqual(["node", "two words", "", "C:\\tools\\server.js", ";", "$(touch marker)", "*.ts", "${VALUE}"]);
  expect(commandWords(`a\\ b "say \\"hi\\"" 'verbatim\\path'`)).toEqual(["a b", 'say "hi"', "verbatim\\path"]);
  expect(parseConfigCommand(`add --scope project --env 'KEY=!secret lookup' --env EMPTY= worker -- node 'two words' --scope global`))
    .toEqual({ action: "add", scope: "project", server: "worker", replace: false,
      definition: { command: "node", args: ["two words", "--scope", "global"], env: { KEY: "!secret lookup", EMPTY: "" } } });
  expect(parseConfigCommand(`add --scope global --transport http --replace --header 'Authorization: Bearer ${"${TOKEN}"}' docs https://example.com/mcp`))
    .toEqual({ action: "add", scope: "global", server: "docs", replace: true,
      definition: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } } });
  expect(parseConfigCommand("add --scope global --oauth --oauth-client-id client docs https://example.com"))
    .toMatchObject({ definition: { oauth: true, oauthClientId: "client" } });
  expect(parseConfigCommand("remove --scope project docs")).toEqual({ action: "remove", scope: "project", server: "docs" });
  expect(parseConfigCommand("get docs")).toBeUndefined();
});

test("malformed commands fail without reflecting argument values", () => {
  for (const command of [
    "add docs https://private.example", "remove docs", "add --scope bad docs https://private.example",
    "add --scope global --scope project docs https://private.example", "remove --scope global docs extra",
    "remove --scope global --replace docs", "add --scope global docs", "add --scope global docs --",
    "add --scope global docs -- ''", "add --scope global docs https://private.example extra",
    "add --scope global --transport sse docs https://private.example", "add --scope global --transport http docs -- node",
    "add --scope global --transport stdio docs https://private.example", "add --scope global --header private-secret docs https://private.example",
    "add --scope global --header 'X-Key: one' --header 'x-key: private-secret' docs https://private.example",
    "add --scope global --env KEY=one --env KEY=private-secret docs -- node", "add --scope global --env private-secret docs -- node",
    "add --scope global --env KEY=private-secret docs https://private.example", "add --scope global --oauth docs -- node",
    "add --scope global --header 'X-Key: private-secret' docs -- node", "add --scope global --unknown private-secret docs https://private.example",
    "add --scope global '../private-secret' https://private.example", "add --scope global docs 'private-secret", "add --scope global docs private-secret\\",
  ]) {
    try { parseConfigCommand(command); throw new Error("should reject"); }
    catch (error) {
      expect(String(error)).not.toContain("private-secret");
      expect(String(error)).not.toContain("private.example");
      expect(String(error)).not.toContain("should reject");
    }
  }
});

test("configuration completions show scopes and names, not connection values", () => {
  expect(configCommandCompletions("add ", [])!.map((entry) => entry.value)).toEqual(["add --scope global", "add --scope project"]);
  expect(configCommandCompletions("remove --scope p", [])).toEqual([{ value: "remove --scope project", label: "--scope project" }]);
  expect(configCommandCompletions("remove --scope global d", ["docs", "other"])).toEqual([{ value: "remove --scope global docs", label: "docs" }]);
  expect(configCommandCompletions("add --scope global docs https://private.example", [])).toEqual([]);
});

test("add creates private files, remove retains empty documents, and duplicates require replacement", async () => {
  const f = await fixture();
  await f.run("add --scope global docs https://example.com/mcp");
  const global = join(f.agentDir, "mcp.json");
  expect((await stat(global)).mode & 0o777).toBe(0o600);
  expect((await stat(f.agentDir)).mode & 0o777).toBe(0o700);
  const before = await readFile(global, "utf8");
  await expect(f.run("add --scope global docs https://other.example")).rejects.toThrow("already exists");
  await expect(f.run("add --scope project docs https://other.example")).rejects.toThrow("already exists");
  expect(await readFile(global, "utf8")).toBe(before);
  await f.run("add --scope global --replace docs https://other.example");
  expect((await loadConfig(f.agentDir, f.cwd, true)).docs.url).toBe("https://other.example");
  await f.run("remove --scope global docs");
  expect(JSON.parse(await readFile(global, "utf8"))).toEqual({ mcpServers: {} });
  await expect(f.run("remove --scope global docs")).rejects.toThrow("selected scope");
});

test("scoped edits preserve other scopes and removing overrides reveals global definitions", async () => {
  const f = await fixture();
  await f.run("add --scope global docs https://global.example");
  await f.run("add --scope project --replace docs https://project.example");
  const project = await readFile(join(f.cwd, ".mcp.json"), "utf8");
  const hidden = await f.run("add --scope global --replace docs https://replacement.example");
  expect(hidden.config.docs.url).toBe("https://project.example");
  expect(await readFile(join(f.cwd, ".mcp.json"), "utf8")).toBe(project);
  const revealed = await f.run("remove --scope project docs");
  expect(revealed.config.docs.url).toBe("https://replacement.example");
  await expect(f.run("remove --scope project docs")).rejects.toThrow("selected scope");
  await f.run("add --scope project local -- node");
  await f.run("remove --scope global docs");
  expect((await loadConfig(f.agentDir, f.cwd, true)).local.command).toBe("node");
});

test("untrusted project edits are rejected without reading or changing project configuration", async () => {
  const f = await fixture();
  const path = join(f.cwd, ".mcp.json");
  await writeFile(path, "invalid-private-project-json");
  await expect(f.run("add --scope project docs https://example.com", false)).rejects.toThrow("trusted project");
  await expect(f.run("remove --scope project docs", false)).rejects.toThrow("trusted project");
  await f.run("add --scope global docs https://example.com", false);
  await f.run("remove --scope global docs", false);
  expect(await readFile(path, "utf8")).toBe("invalid-private-project-json");
});

test("edits preserve metadata, unresolved secret commands, symlinks, and existing permissions", async () => {
  const f = await fixture();
  await mkdir(f.agentDir);
  const target = join(f.agentDir, "actual.json");
  const existing = { type: "stdio", command: "node", env: { KEY: "!secret-command" }, disabled: true };
  await writeFile(target, JSON.stringify({ metadata: "preserved", mcpServers: { existing } }));
  await chmod(target, 0o640);
  await symlink(target, join(f.agentDir, "mcp.json"));
  await f.run("add --scope global --env 'KEY=!never-execute' worker -- missing-executable '*.txt'");
  const result = JSON.parse(await readFile(target, "utf8"));
  expect(result.metadata).toBe("preserved");
  expect(result.mcpServers.existing).toEqual(existing);
  expect(result.mcpServers.worker.env.KEY).toBe("!never-execute");
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect((await lstat(join(f.agentDir, "mcp.json"))).isSymbolicLink()).toBe(true);
  await f.run("remove --scope global worker");
  expect((await readdir(f.agentDir)).sort()).toEqual(["actual.json", "mcp.json"]);
});

test("validation never saves resolved environment values", async () => {
  const f = await fixture();
  process.env.MCP_CONFIG_COMMAND_TOKEN = "private-resolved-token";
  try {
    await f.run("add --scope global --header 'Authorization: Bearer ${MCP_CONFIG_COMMAND_TOKEN}' docs https://example.com");
    const saved = await readFile(join(f.agentDir, "mcp.json"), "utf8");
    expect(saved).toContain("${MCP_CONFIG_COMMAND_TOKEN}");
    expect(saved).not.toContain("private-resolved-token");
  } finally { delete process.env.MCP_CONFIG_COMMAND_TOKEN; }
});

test("invalid, cancelled, or malformed edits leave files intact and remove temporary files", async () => {
  const f = await fixture();
  await f.run("add --scope global docs https://example.com");
  const path = join(f.agentDir, "mcp.json");
  const before = await readFile(path, "utf8");
  for (const command of [
    "add --scope global --replace docs ftp://example.com",
    "add --scope global --oauth-client-id client other https://example.com",
    "add --scope global --oauth --header 'Authorization: private-secret' other https://example.com",
  ]) await expect(f.run(command)).rejects.toThrow();
  let validations = 0;
  await expect(f.run("remove --scope global docs", true, () => {
    if (++validations > 1) throw new Error("cancelled");
  })).rejects.toThrow("cancelled");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(await readdir(f.agentDir)).toEqual(["mcp.json"]);
  await writeFile(path, "invalid-private-json");
  await expect(f.run("add --scope global another https://example.com")).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("invalid-private-json");
});

test("concurrent adds, removes, and toggles share the mutation queue", async () => {
  const f = await fixture();
  await Promise.all(["a", "b", "c"].map((name) => f.run(`add --scope global ${name} -- node`)));
  await Promise.all([
    f.run("remove --scope global a"),
    f.run("add --scope global d -- node"),
    setServerDisabled(f.agentDir, f.cwd, true, "b", true, f.validate),
  ]);
  const result = await loadConfig(f.agentDir, f.cwd, true);
  expect(Object.keys(result).sort()).toEqual(["b", "c", "d"]);
  expect(result.b.disabled).toBe(true);
});

test("new files reached through parent-directory aliases share a lock", async () => {
  const f = await fixture();
  await mkdir(f.agentDir);
  const alias = join(f.root, "agent-alias");
  await symlink(f.agentDir, alias);
  await Promise.all([f.agentDir, alias].map((directory, index) => updateServerConfig(
    directory, f.cwd, false, parseConfigCommand(`add --scope global server${index} -- node`)!, f.validate,
  )));
  expect(Object.keys(await loadConfig(f.agentDir, f.cwd, false)).sort()).toEqual(["server0", "server1"]);
});

test("scoped edits refuse ambiguous and dangling symlinks", async () => {
  const f = await fixture();
  await f.run("add --scope global docs -- node");
  const global = join(f.agentDir, "mcp.json");
  const project = join(f.cwd, ".mcp.json");
  await symlink(global, project);
  const before = await readFile(global, "utf8");
  await expect(f.run("remove --scope global docs")).rejects.toThrow("share a file");
  expect(await readFile(global, "utf8")).toBe(before);
  await rm(project);
  await symlink(join(f.cwd, "missing.json"), project);
  await expect(f.run("add --scope project local -- node")).rejects.toThrow("dangling symlink");
  expect((await lstat(project)).isSymbolicLink()).toBe(true);
});

test("adding a shadowed invalid definition still fails validation", async () => {
  const f = await fixture();
  await f.run("add --scope project docs https://example.com");
  await expect(f.run("add --scope global --replace docs ftp://example.com")).rejects.toThrow();
  expect((await loadConfig(f.agentDir, f.cwd, true)).docs.url).toBe("https://example.com");
});
