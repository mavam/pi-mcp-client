// Keep the deadline outside the child: an in-process test timeout cannot
// interrupt a blocked event loop or synchronous native call.
export async function runBun(args: string[], timeoutMs: number): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut || code !== 0) {
      const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited with code ${code}`;
      throw new Error(`Bun subprocess ${reason}\n${(stdout + stderr).slice(-16_000)}`);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
