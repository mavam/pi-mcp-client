import { expect, test } from "bun:test";
import { runBun } from "./helpers/subprocess.js";

test("subprocess succeeds only when the fixture exits successfully", async () => {
  await runBun(["-e", "console.error('done')"], 5_000);
  await expect(runBun(["-e", "console.error('assert prompt results'); throw new Error('fixture failed')"], 5_000))
    .rejects.toThrow("fixture failed");
});

for (const stall of ["setInterval(() => {}, 1000); await new Promise(() => {})", "while (true) {}"]) {
  test(`subprocess deadline kills a stalled fixture: ${stall}`, async () => {
    await expect(runBun(["-e", `console.error('close MCP server'); ${stall}`], 1_000))
      .rejects.toThrow("timed out after 1000ms\nclose MCP server");
  }, 5_000);
}
