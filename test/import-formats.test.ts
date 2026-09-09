import { expect, test } from "bun:test";
import { stringify } from "smol-toml";
import { parseConfig, resolveServer } from "../src/config.js";
import { parseImportSource, importPreview, validateImportCandidate } from "../src/imports.js";

const codex = (definition: object) => parseImportSource(stringify({ mcp_servers: { example: definition } })).candidates[0];

test("Codex TOML supports comments, quoted names, multiline strings, arrays, and separate timeouts", () => {
  const result = parseImportSource(`# A real TOML document, not a line-oriented parser.
model = "private-model"
[mcp_servers."node-repl"]
command = 'node'
args = [
  'server.js', # trailing comments and commas are valid TOML
]
cwd = '/workspace'
enabled = false
startup_timeout_sec = 1.001
tool_timeout_sec = 90
[mcp_servers."node-repl".env]
TEXT = '''first line
second line'''
`);
  expect(result.format).toBe("codex");
  expect(result.ignoredTopLevel).toBe(1);
  expect(result.candidates[0].name).toBe("node-repl");
  expect(result.candidates[0].definition).toEqual({
    command: "node", args: ["server.js"], cwd: "/workspace", disabled: true,
    startupTimeoutMs: 1001, toolTimeoutMs: 90_000, env: { TEXT: "first line\nsecond line" },
  });
  expect(importPreview(result.candidates[0])).toContain("Startup timeout: 1001 ms; tool timeout: 90000 ms");
  expect(codex({ command: "node", startup_timeout_ms: 2000 }).definition).toMatchObject({ startupTimeoutMs: 2000, toolTimeoutMs: 60_000 });
  expect(codex({ command: "node" }).definition).toMatchObject({ startupTimeoutMs: 10_000, toolTimeoutMs: 60_000 });
});

test("Codex literal values and explicit environment references remain distinct", () => {
  process.env.MCP_CODEX_TOKEN = "private-token";
  process.env.MCP_CODEX_HEADER = "private-header";
  try {
    const local = codex({ command: "node", env: { LITERAL: "${MCP_CODEX_TOKEN}", BARE: "$MCP_CODEX_TOKEN", COMMAND: "!never-run" }, env_vars: ["MCP_CODEX_TOKEN"] });
    expect(validateImportCandidate(local, process.cwd())).toBeUndefined();
    expect(resolveServer(local.definition!, process.cwd()).env).toEqual({
      LITERAL: "${MCP_CODEX_TOKEN}", BARE: "$MCP_CODEX_TOKEN", COMMAND: "!never-run", MCP_CODEX_TOKEN: "private-token",
    });
    const remote = codex({ url: "https://example.com/mcp", http_headers: { "X-Literal": "${MCP_CODEX_TOKEN}" },
      env_http_headers: { "X-Token": "MCP_CODEX_HEADER" }, bearer_token_env_var: "MCP_CODEX_TOKEN" });
    expect(resolveServer(remote.definition!, process.cwd()).headers).toEqual({
      "X-Literal": "${MCP_CODEX_TOKEN}", "X-Token": "private-header", Authorization: "Bearer private-token",
    });
    expect(JSON.stringify(remote.definition)).not.toContain("private-token");
    expect(JSON.stringify(local.definition)).not.toContain("private-token");
    expect(importPreview(remote)).not.toContain("private-");
  } finally { delete process.env.MCP_CODEX_TOKEN; delete process.env.MCP_CODEX_HEADER; }
});

test("Codex exact tool filters, disabled state, and OAuth scopes are preserved", () => {
  const entry = codex({ url: "https://example.com", enabled: true, enabled_tools: ["get", "post"], disabled_tools: ["post"], scopes: ["read"], required: false, experimental_environment: "local" });
  expect(entry.definition).toMatchObject({ disabled: false, includeTools: ["get", "post"], excludeTools: ["post"], oauthScopes: ["read"] });
  expect(codex({ command: "node", enabled_tools: [] }).definition!.includeTools).toEqual([]);
});

test("Codex refuses lossy or conflicting conversions rather than dropping restrictions", () => {
  for (const definition of [
    { command: "node", required: true }, { command: "node", experimental_environment: "remote" },
    { command: "node", default_tools_approval_mode: "prompt" }, { command: "node", enabled_tools: ["get_*"] },
    { command: "node", disabled_tools: ["*"] }, { command: "node", startup_timeout_sec: 10, startup_timeout_ms: 10_000 },
    { command: "node", startup_timeout_sec: 0.01 }, { command: "node", tool_timeout_sec: Infinity },
    { command: "node", startup_timeout_sec: NaN }, { command: "node", startup_timeout_ms: 600_001 },
    { command: "node", tool_timeout_sec: -1 }, { command: "node", enabled: "false" },
    { command: "node", env_vars: [{ name: "KEY", source: "remote" }] },
    { command: "node", env_vars: ["KEY"], env: { KEY: "private-value" } },
    { command: "${MCP_CODEX_TOKEN}" }, { command: "node", args: ["${MCP_CODEX_TOKEN}"] },
    { command: "node", env: new Date() },
    { url: "https://example.com", http_headers: { authorization: "private-value" }, bearer_token_env_var: "TOKEN" },
    { url: "https://example.com", http_headers: { "X-Key": "private-value" }, env_http_headers: { "x-key": "TOKEN" } },
    { url: "https://example.com", bearer_token_env_var: "!private-value" },
  ]) {
    const entry = codex(definition);
    expect(entry.definition).toBeUndefined();
    expect(entry.problem).toBeDefined();
    expect(importPreview(entry, entry.problem)).not.toContain("private-value");
  }
});

test("TOML errors and unsupported shapes do not expose parser snippets", () => {
  for (const source of [
    '[mcp_servers.example]\ncommand = "private-value\n',
    '[mcp_servers.example]\ncommand = "private-value"\ncommand = "duplicate"',
    'mcp_servers = "private-value"',
    '[other]\nkey = "private-value"',
  ]) {
    try { parseImportSource(source); throw new Error("should reject"); }
    catch (error) {
      expect(String(error)).not.toContain("private-value");
      expect(String(error)).not.toContain("should reject");
    }
  }
});

test("Claude project-local server groups remain separate and bounded", () => {
  const parsed = parseImportSource(JSON.stringify({ mcpServers: { shared: { command: "global" } }, projects: {
    "/one": { mcpServers: { shared: { command: "one" } }, other: "private-value" },
    "/two\u001b[31m": { mcpServers: { shared: { command: "two" } } },
    "/empty": { mcpServers: {} },
  } }));
  expect(parsed.groups).toHaveLength(3);
  expect(parsed.candidates).toHaveLength(3);
  expect(parsed.candidates.map((entry) => entry.definition!.command)).toEqual(["global", "one", "two"]);
  expect(new Set(parsed.candidates.map((entry) => entry.group)).size).toBe(3);
  expect(parsed.groups!.join("\n")).not.toContain("\u001b");
  expect(parsed.ignoredTopLevel).toBe(0);
  expect(() => parseImportSource(JSON.stringify({ projects: { "/bad": { mcpServers: "private-value" } } }))).toThrow("invalid mcpServers");
  const servers = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`s${i}`, { command: "node" }]));
  expect(() => parseImportSource(JSON.stringify({ projects: { "/one": { mcpServers: servers }, "/two": { mcpServers: servers } } }))).toThrow("100 servers");
});

test("startup and tool timeout options use the same bounded millisecond validation", () => {
  for (const field of ["startupTimeoutMs", "toolTimeoutMs"]) {
    for (const value of [0, 99, 600_001, Infinity, 100.1, "1000", null])
      expect(() => parseConfig({ mcpServers: { example: { command: "node", [field]: value } } })).toThrow();
    for (const value of [100, 600_000])
      expect(parseConfig({ mcpServers: { example: { command: "node", [field]: value } } }).example).toHaveProperty(field, value);
  }
});
