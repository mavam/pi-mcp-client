import { expect, test } from "bun:test";
import { resolveServer } from "../src/config.js";
import { resolveSecrets, secretCommand, secretTemplate } from "../src/secrets.js";

test("Pi templates preserve escapes, literals, and shell expressions", () => {
  expect(secretTemplate("$!printf nope")).toBe("!printf nope");
  expect(secretTemplate("$$TOKEN")).toBe("$TOKEN");
  expect(secretTemplate("$A/${B}", { A: "x", B: "!printf nope" })).toBe(
    "x/!printf nope",
  );
  expect(secretTemplate("!printf '${MISSING}'", {})).toBe("!printf '${MISSING}'");
  expect(secretTemplate("${bad-name}", {})).toBe("${bad-name}");
  expect(() => secretTemplate("$MISSING", {})).toThrow("[configuration_invalid]");
});

test("commands trim stdout and do not re-interpret output or escaped literals", async () => {
  const original = {
    command: "!not-a-shell-command",
    args: ["!not-a-command"],
    env: { TOKEN: "!printf '  $!literal  \\n'", LITERAL: "$!printf nope" },
  };
  const resolved = resolveServer(original, process.cwd());
  expect(resolved.env?.TOKEN).toBe(original.env.TOKEN);
  const result = await resolveSecrets(
    resolved,
    original,
    process.cwd(),
    AbortSignal.timeout(1000),
  );
  expect(result.env).toEqual({ TOKEN: "$!literal", LITERAL: "!printf nope" });
  expect(result.command).toBe(original.command);
  expect(result.args).toEqual(original.args);
  expect(original.env.TOKEN).toStartWith("!");
});

test("empty, unsuccessful, excessive, and invalid commands fail without leaking secrets", async () => {
  for (const command of [
    "printf ''",
    "printf secret; printf stderr-secret >&2; exit 7",
    "yes secret",
    "printf '\0secret'",
  ]) {
    try {
      await secretCommand(command, process.cwd(), AbortSignal.timeout(1000));
      throw new Error("Unexpected success");
    } catch (error) {
      expect((error as Error).message).toContain("[secret_lookup_failed]");
      expect((error as Error).message).not.toContain("stderr-secret");
      expect((error as Error).cause).toBeUndefined();
    }
  }
});

test("commands respect cancellation, deadlines, and working directory", async () => {
  expect(
    await secretCommand("printf '%s' \"$PWD\"", "/", AbortSignal.timeout(1000)),
  ).toBe("/");
  await expect(
    secretCommand("sleep 30", process.cwd(), AbortSignal.timeout(30)),
  ).rejects.toThrow("[timeout]");
  const abort = new AbortController();
  const running = secretCommand("sleep 30", process.cwd(), abort.signal);
  abort.abort(new Error("private-reason"));
  await expect(running).rejects.toThrow("[cancelled]");
  await expect(
    secretCommand("printf unused", process.cwd(), abort.signal),
  ).rejects.toThrow("[cancelled]");
});
