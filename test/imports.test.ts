import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectConfigScopes, loadConfig, resolveServer, updateServerConfig, type Config, type ConfigMutation } from "../src/config.js";
import { configCommandCompletions } from "../src/config-commands.js";
import { importPreview, MAX_IMPORT_BYTES, parseImportCommand, parseImportSource, readImportSource, validateImportCandidate } from "../src/imports.js";
import { resolveSecrets } from "../src/secrets.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mcp-import-"));
  directories.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const sourcePath = join(root, "source.json");
  const validate = (config: Config) => {
    for (const definition of Object.values(config)) if (!definition.disabled) resolveServer(definition, cwd);
  };
  const plan = async (servers: Config, scope: "global" | "project" = "global", trusted = true): Promise<Extract<ConfigMutation, { action: "import" }>> => ({
    action: "import", scope, servers, sourcePath,
    expected: (await inspectConfigScopes(agentDir, cwd, trusted)).expected,
  });
  return { root, agentDir, cwd, sourcePath, validate, plan,
    save: (mutation: ConfigMutation, trusted = true, check = validate) => updateServerConfig(agentDir, cwd, trusted, mutation, check) };
}

const source = (mcpServers: object) => JSON.stringify({ mcpServers });

test("import command requires a scope and one quoted path without shell expansion", () => {
  expect(parseImportCommand(`import --scope project 'path with spaces.json'`)).toEqual({ scope: "project", path: "path with spaces.json" });
  expect(parseImportCommand(`import --scope global '${"${HOME}"}/$(touch marker).json'`).path).toBe("${HOME}/$(touch marker).json");
  expect(parseImportCommand(`import --scope global 'C:\\Users\\me\\mcp.json'`).path).toBe("C:\\Users\\me\\mcp.json");
  for (const command of [
    "import private-secret", "import --scope wrong private-secret", "import --scope global", "import --scope global ''",
    "import --scope global private-secret extra", "import --scope global --yes private-secret", "import --scope global 'private-secret",
  ]) {
    try { parseImportCommand(command); throw new Error("should reject"); }
    catch (error) {
      expect(String(error)).not.toContain("private-secret");
      expect(String(error)).not.toContain("should reject");
    }
  }
  expect(configCommandCompletions("import --scope p", [])).toEqual([{ value: "import --scope project", label: "--scope project" }]);
  expect(configCommandCompletions("import --scope global ", ["private-server"])).toEqual([]);
});

test("source parsing isolates unsupported entries without dropping server fields", () => {
  const result = parseImportSource(JSON.stringify({ unrelated: "private-setting", mcpServers: {
    local: { type: "stdio", command: "private-command", args: ["private-arg"], disabled: true },
    remote: { type: "http", url: "https://example.com/private-token", headers: { Authorization: "private-header" } },
    sse: { type: "sse", url: "https://example.com/private-token" },
    unknown: { command: "node", autoApprove: ["private-value"] },
    malformed: { url: "https://example.com", args: [] },
    primitive: "private-value",
    "\u001b[31mprivate-name": { command: "node" },
  } }));
  expect(result.ignoredTopLevel).toBe(1);
  expect(result.candidates).toHaveLength(7);
  expect(result.candidates[0].definition).toEqual({ command: "private-command", args: ["private-arg"], disabled: true });
  expect(result.candidates[1].definition).toMatchObject({ url: "https://example.com/private-token" });
  expect(result.candidates[2].problem).toContain("SSE");
  expect(result.candidates[3].problem).toContain("unsupported server field");
  expect(result.candidates.slice(2, 6).every((entry) => !entry.definition)).toBe(true);
  expect(result.candidates[6].name).toBeUndefined();
  expect(result.candidates[6].definition).toEqual({ command: "node" });
  for (const entry of result.candidates) {
    const preview = importPreview(entry, entry.problem);
    expect(preview).not.toContain("private-");
    expect(preview).not.toContain("\u001b");
  }
});

test("foreign variable and secret-command syntax is never silently reinterpreted", async () => {
  const f = await fixture();
  const marker = join(f.root, "must-not-exist");
  process.env.MCP_IMPORT_TOKEN = "resolved-private-token";
  try {
    const raw = { command: "never-run", env: {
      COMMAND: `!touch '${marker}'`, BARE: "$MCP_IMPORT_TOKEN", REF: "${MCP_IMPORT_TOKEN}",
      DOLLAR: "$$", ESCAPED: "$!not-a-command", MIX: "${MCP_IMPORT_TOKEN} $MCP_IMPORT_TOKEN",
    } };
    const entry = parseImportSource(source({ local: raw })).candidates[0];
    expect(entry.escapedLiterals).toBe(true);
    expect(entry.definition!.env!.COMMAND).toStartWith("$!");
    expect(validateImportCandidate(entry, f.cwd)).toBeUndefined();
    const resolved = await resolveSecrets(resolveServer(entry.definition!, f.cwd), entry.definition!, f.cwd, new AbortController().signal);
    expect(resolved.env).toEqual({ ...raw.env, REF: "resolved-private-token", MIX: "resolved-private-token $MCP_IMPORT_TOKEN" });
    expect(JSON.stringify(entry.definition)).not.toContain("resolved-private-token");
    await expect(stat(marker)).rejects.toThrow();
    for (const value of ["${env:TOKEN}", "${TOKEN:-default}", "${workspaceFolder}", "${input:token}", "${unterminated"]) {
      const candidate = parseImportSource(source({ local: { command: "node", env: { KEY: value } } })).candidates[0];
      expect(candidate.problem).toContain("Unsupported variable syntax");
    }
  } finally { delete process.env.MCP_IMPORT_TOKEN; }
});

test("missing variables and invalid URLs fail with redacted diagnostics", () => {
  for (const definition of [
    { url: "https://user:private-token@example.com" }, { url: "ftp://private-token" },
    { command: "${MCP_IMPORT_MISSING_ENV_12345}", args: ["private-token"] },
  ]) {
    const entry = parseImportSource(source({ example: definition })).candidates[0];
    const problem = validateImportCandidate(entry, process.cwd());
    expect(problem).toContain("Cannot validate");
    expect(importPreview(entry, problem)).not.toContain("private-token");
  }
});

test("bounded sources reject unsupported formats, invalid encoding, and non-files safely", async () => {
  const f = await fixture();
  for (const text of ["private-token invalid JSON", "{\"mcpServers\":{},}", "{\"servers\":{}}", "[]", "null"]) {
    expect(() => parseImportSource(text)).toThrow();
    try { parseImportSource(text); } catch (error) { expect(String(error)).not.toContain("private-token"); }
  }
  expect(() => parseImportSource(" ".repeat(MAX_IMPORT_BYTES + 1))).toThrow("1 MiB");
  expect(() => parseImportSource(source(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), { command: "node" }]))))).toThrow("100 servers");
  expect(parseImportSource(source({})).candidates).toEqual([]);
  await writeFile(f.sourcePath, source({ docs: { url: "https://example.com" } }));
  const alias = join(f.root, "alias.json");
  await symlink(f.sourcePath, alias);
  expect((await readImportSource(alias, f.cwd)).path).toBe(await realpath(f.sourcePath));
  await expect(readImportSource(f.sourcePath, f.cwd, AbortSignal.abort())).rejects.toThrow();
  await expect(readImportSource(f.root, f.cwd)).rejects.toThrow("regular file");
  await expect(readImportSource("missing-private-token", f.cwd)).rejects.toThrow("Cannot open import file");
  await writeFile(f.sourcePath, Buffer.from([0xff]));
  await expect(readImportSource(f.sourcePath, f.cwd)).rejects.toThrow("UTF-8 JSON");
  await writeFile(f.sourcePath, " ".repeat(MAX_IMPORT_BYTES + 1));
  await expect(readImportSource(f.sourcePath, f.cwd)).rejects.toThrow("1 MiB");
});

test("a batch import atomically replaces whole definitions and preserves unrelated settings", async () => {
  const f = await fixture();
  await mkdir(f.agentDir);
  const file = join(f.agentDir, "mcp.json");
  await writeFile(file, JSON.stringify({ metadata: "keep", mcpServers: {
    existing: { url: "https://old.example", headers: { Authorization: "old-secret" } },
    untouched: { command: "node", env: { KEY: "!never-run" } },
  } }));
  await chmod(file, 0o640);
  await f.save(await f.plan({ existing: { url: "https://new.example" }, added: { command: "never-run" } }));
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved.metadata).toBe("keep");
  expect(saved.mcpServers.existing).toEqual({ url: "https://new.example" });
  expect(saved.mcpServers.untouched.env.KEY).toBe("!never-run");
  expect(saved.mcpServers.added.command).toBe("never-run");
  expect((await stat(file)).mode & 0o777).toBe(0o640);
  expect(await readdir(f.agentDir)).toEqual(["mcp.json"]);
});

test("stale previews reject new conflicts, changed definitions, and changed symlink targets", async () => {
  const f = await fixture();
  const pending = await f.plan({ new: { command: "node" } });
  await f.save(await f.plan({ new: { command: "other" } }));
  await expect(f.save(pending)).rejects.toThrow("changed since the preview");
  const second = await f.plan({ new: { command: "node" } });
  const file = join(f.agentDir, "mcp.json");
  const before = await readFile(file, "utf8");
  const target = join(f.root, "target.json");
  await writeFile(target, before);
  await rm(file);
  await symlink(target, file);
  await expect(f.save(second)).rejects.toThrow("changed since the preview");
  expect(await readFile(target, "utf8")).toBe(before);
  const third = await f.plan({ new: { command: "node" } });
  await writeFile(join(f.cwd, ".mcp.json"), source({ new: { command: "project" } }));
  await expect(f.save(third)).rejects.toThrow("changed since the preview");
});

test("validation and cancellation roll back the entire batch, including shadowed and disabled entries", async () => {
  const f = await fixture();
  await f.save(await f.plan({ existing: { command: "node" } }));
  await writeFile(join(f.cwd, ".mcp.json"), source({ invalid: { command: "project" } }));
  const file = join(f.agentDir, "mcp.json");
  const before = await readFile(file, "utf8");
  await expect(f.save(await f.plan({ good: { command: "node" }, invalid: { url: "ftp://example.com", disabled: true } }))).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  let validations = 0;
  await expect(f.save(await f.plan({ good: { command: "node" } }), true, () => {
    if (++validations > 1) throw new Error("cancelled before rename");
  })).rejects.toThrow("cancelled before rename");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(await readdir(f.agentDir)).toEqual(["mcp.json"]);
});

test("scopes retain precedence, protect untrusted projects, and refuse source/destination aliases", async () => {
  const f = await fixture();
  await f.save(await f.plan({ docs: { url: "https://global.example" } }));
  expect((await stat(join(f.agentDir, "mcp.json"))).mode & 0o777).toBe(0o600);
  await f.save(await f.plan({ docs: { url: "https://project.example" } }, "project"));
  expect((await loadConfig(f.agentDir, f.cwd, true)).docs.url).toBe("https://project.example");
  await f.save(await f.plan({ docs: { url: "https://updated.example" } }));
  expect((await loadConfig(f.agentDir, f.cwd, true)).docs.url).toBe("https://project.example");
  await writeFile(join(f.cwd, ".mcp.json"), "untrusted-private-content");
  await expect(f.save(await f.plan({ docs: { command: "node" } }, "project", false), false)).rejects.toThrow("trusted project");
  await f.save(await f.plan({ local: { command: "node" } }, "global", false), false);
  expect(await readFile(join(f.cwd, ".mcp.json"), "utf8")).toBe("untrusted-private-content");
  const mutation = await f.plan({ docs: { command: "node" } }, "global", false);
  mutation.sourcePath = await realpath(join(f.agentDir, "mcp.json"));
  await expect(f.save(mutation, false)).rejects.toThrow("same file");
  await rm(join(f.cwd, ".mcp.json"));
  await symlink(join(f.agentDir, "mcp.json"), join(f.cwd, ".mcp.json"));
  await expect(inspectConfigScopes(f.agentDir, f.cwd, true)).rejects.toThrow("share a file");
  expect((await lstat(join(f.cwd, ".mcp.json"))).isSymbolicLink()).toBe(true);
});
