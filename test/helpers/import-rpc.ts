import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../src/config.js";

/** Exercise the actual Pi CLI, RPC dialogs, extension loader, command, and disk write. */
export async function importThroughRpc(source: string, options: {
  extension?: string;
  confirm?: boolean;
} = {}): Promise<{ config: Config; notifications: string[]; uiText: string[]; dialogs: number }> {
  const directory = await mkdtemp(join(tmpdir(), "mcp-import-rpc-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { mode: 0o700 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProjectTrust: "never", enableInstallTelemetry: false,
  }), { mode: 0o600 });
  const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const extension = options.extension ?? fileURLToPath(new URL("../../src/index.ts", import.meta.url));
  const child = spawn("node", [cli, "--mode", "rpc", "--no-session", "--no-extensions", "-e", extension,
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--no-approve"], {
    cwd: directory,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"), PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const notifications: string[] = [];
  const uiText: string[] = [];
  let dialogs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      // Deliberately omit raw stderr, RPC error payloads, and configuration from failures.
      // This helper is also used against real user configurations outside CI.
      const fail = (reason: string) => reject(new Error(reason));
      timer = setTimeout(() => { fail("Pi import RPC timed out."); child.kill("SIGKILL"); }, 20_000);
      child.on("error", () => fail("Could not start Pi for the import test."));
      child.on("exit", () => fail("Pi exited before completing the import test."));
      child.stdin.on("error", () => fail("Pi import RPC input closed unexpectedly."));
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      let buffer = "";
      const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024) { fail("Pi import RPC output exceeded its limit."); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { fail("Pi emitted invalid RPC output."); return; }
          if (event.type === "extension_ui_request") {
            for (const text of [event.title, event.message]) if (typeof text === "string") uiText.push(text);
            if (event.method === "select") {
              dialogs++;
              const choices: string[] = event.options;
              const choice = choices.includes("All groups") ? "All groups"
                : choices.find((value) => /^(Add |Replace |Override )/u.test(value))
                  ?? choices.find((value) => ["Continue", "Next page", "Continue to confirmation"].includes(value));
              if (!choice) { fail("An import entry could not be selected without dropping or renaming settings."); return; }
              send({ type: "extension_ui_response", id: event.id, value: choice });
            } else if (event.method === "confirm") {
              dialogs++;
              send({ type: "extension_ui_response", id: event.id, confirmed: options.confirm !== false });
            } else if (event.method === "notify") {
              if (event.notifyType === "error") { fail("Pi import emitted an error notification."); return; }
              notifications.push(event.message);
            } else { fail("Pi import requested an unexpected UI interaction."); return; }
          } else if (event.type === "response") {
            if (!event.success) { fail("Pi rejected the import RPC command."); return; }
            if (event.id === "import") send({ id: "status", type: "prompt", message: "/mcp" });
            if (event.id === "status") send({ id: "messages", type: "get_messages" });
            if (event.id === "messages") {
              if (event.data.messages.length !== 0) { fail("Import unexpectedly added model context."); return; }
              resolve();
            }
          } else if (event.type === "agent_start" || event.type === "extension_error") {
            fail("Import unexpectedly started the agent or raised an extension error."); return;
          }
        }
      });
      send({ id: "import", type: "prompt", message: `/mcp import --scope global ${JSON.stringify(source)}` });
    });
    const status = notifications.at(-1) ?? "";
    if (/[●▶✘]/u.test(status)) throw new Error("Import unexpectedly connected a server.");
    const document = await readFile(join(agentDir, "mcp.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && options.confirm === false) return '{"mcpServers":{}}';
      throw new Error("Pi import did not save its configuration.");
    });
    return { config: JSON.parse(document).mcpServers, notifications, uiText, dialogs };
  } finally {
    if (timer) clearTimeout(timer);
    child.kill("SIGKILL");
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}
