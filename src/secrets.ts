import { spawn } from "node:child_process";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { ServerConfig } from "./config.js";
import { failure } from "./diagnostics.js";

/** Resolve templates without ever interpreting the result as a command. */
export function secretTemplate(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (value.startsWith("!")) return value;
  return value.replace(
    /\$\$|\$!|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced, bare) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const name = braced ?? bare;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return match;
      const found = env[name];
      if (found === undefined)
        throw failure("configuration_invalid", { operation: "configuration" });
      return found;
    },
  );
}

/** Errors deliberately carry neither command text nor captured output. */
export function secretCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fail = () =>
      failure(
        signal.aborted
          ? signal.reason?.name === "TimeoutError"
            ? "timeout"
            : "cancelled"
          : "secret_lookup_failed",
        { operation: "connect" },
      );
    if (signal.aborted) {
      reject(fail());
      return;
    }
    let shell: ReturnType<typeof getShellConfig>;
    try {
      shell =
        process.platform === "win32"
          ? getShellConfig()
          : { shell: "/bin/sh", args: ["-c"] };
    } catch {
      reject(fail());
      return;
    }
    const stdin = shell.commandTransport === "stdin";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell.shell, stdin ? shell.args : [...shell.args, command], {
        cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "ignore"],
      });
    } catch {
      reject(fail());
      return;
    }
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).on("error", () => child.kill("SIGKILL"));
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      const value = ok ? Buffer.concat(chunks).toString("utf8").trim() : "";
      chunks.length = 0;
      if (ok && value) resolve(value);
      else {
        kill();
        reject(fail());
      }
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", abort);
    child.stdout?.on("error", abort);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > 64 * 1024) finish(false);
      else chunks.push(chunk);
    });
    child.on("close", (code) => finish(code === 0));
    child.stdin?.on("error", abort);
    if (stdin) child.stdin?.end(command);
    if (signal.aborted) abort();
  });
}

export async function resolveSecrets(
  resolved: ServerConfig,
  original: ServerConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<ServerConfig> {
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.min(original.timeoutMs ?? 10_000, 10_000)),
  ]);
  const result = { ...resolved };
  for (const field of ["headers", "env"] as const) {
    if (!original[field]) continue;
    result[field] = { ...resolved[field] };
    for (const [key, value] of Object.entries(original[field])) {
      // Inspect original configuration, never interpolated values or command output.
      if (value.startsWith("!"))
        result[field][key] = await secretCommand(
          value.slice(1),
          resolved.cwd ?? cwd,
          bounded,
        );
    }
  }
  return result;
}
