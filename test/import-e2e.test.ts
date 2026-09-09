import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importThroughRpc } from "./helpers/import-rpc.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

for (const format of ["claude", "codex"] as const) {
  for (const confirm of [true, false]) {
    test(`real Pi RPC imports ${format} configuration (${confirm ? "save" : "cancel"})`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "mcp-import-e2e-"));
      directories.push(directory);
      const path = join(directory, format === "claude" ? ".claude.json" : "config.toml");
      const marker = join(directory, "must-not-exist");
      const content = format === "claude" ? JSON.stringify({
        unrelated: "private-fixture-setting",
        projects: {
          "/project/one": { mcpServers: { docs: { type: "http", url: "https://example.com/private-fixture-path", headers: { Authorization: "private-fixture-token" } } } },
          "/project/two": { mcpServers: { local: { command: "sh", args: ["-c", `touch '${marker}'`] } } },
        },
      }) : `model = "private-fixture-model"
[mcp_servers.local]
command = "sh"
args = ["-c", "touch '${marker}'"]
startup_timeout_sec = 1.25
tool_timeout_sec = 2.5
[mcp_servers.local.env]
TOKEN = "!touch '${marker}'"
LITERAL = '\${NOT_AN_ENV_REFERENCE}'
[mcp_servers.disabled]
command = "never-run"
enabled = false
`;
      await writeFile(path, content, { mode: 0o600 });
      const result = await importThroughRpc(path, { confirm });
      expect(result.dialogs).toBeGreaterThanOrEqual(5);
      expect(result.uiText.join("\n")).not.toContain("private-fixture");
      if (!confirm) expect(result.config).toEqual({});
      else if (format === "claude") {
        expect(Object.keys(result.config).sort()).toEqual(["docs", "local"]);
        expect(result.config.docs.headers!.Authorization).toBe("private-fixture-token");
        expect(result.config.local.args).toEqual(["-c", `touch '${marker}'`]);
      } else {
        expect(result.config.local).toMatchObject({ startupTimeoutMs: 1250, toolTimeoutMs: 2500 });
        expect(result.config.local.env).toEqual({ TOKEN: `$!touch '${marker}'`, LITERAL: "$${NOT_AN_ENV_REFERENCE}" });
        expect(result.config.disabled).toMatchObject({ disabled: true, startupTimeoutMs: 10_000, toolTimeoutMs: 60_000 });
      }
      expect(await readFile(path, "utf8")).toBe(content);
      await expect(stat(marker)).rejects.toThrow();
    }, 30_000);
  }
}
