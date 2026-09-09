import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runBun } from "./helpers/subprocess.js";

const fixture = fileURLToPath(new URL("./fixtures/integration-case.ts", import.meta.url));

// Isolate Pi/provider globals from other tests and from the next provider case.
// The parent can kill a stuck child even when Bun's in-process timeout cannot
// fire. On failure, the fixture's phase log identifies the last operation.
for (const context of ["resource", "template"]) {
  for (const mode of ["anthropic", "openai", "fallback"]) {
    test(`Pi ${mode}: discover, read ${context} context, activate, then call a native tool`, async () => {
      await runBun([fixture, mode, context], 15_000);
    }, 20_000);
  }
}
