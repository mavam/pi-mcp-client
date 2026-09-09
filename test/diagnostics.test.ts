import { expect, test } from "bun:test";
import {
  SdkError,
  SdkErrorCode,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  diagnose,
  diagnostic,
  DiagnosticError,
  failure,
  formatDiagnostic,
} from "../src/diagnostics.js";

const context = { server: "example", operation: "connect", oauth: true } as const;

test("diagnostics classify SDK and OS failures without echoing error payloads", () => {
  for (const [error, code] of [
    [new UnauthorizedError("secret-token"), "authentication_required"],
    [new SdkError(SdkErrorCode.RequestTimeout, "secret-token"), "timeout"],
    [new SdkError(SdkErrorCode.InvalidResult, "secret-token"), "protocol_error"],
    [new SdkError(SdkErrorCode.ConnectionClosed, "secret-token"), "connection_failed"],
    [
      new Error("secret-token", {
        cause: Object.assign(new Error("private-path"), { code: "ENOENT" }),
      }),
      "connection_failed",
    ],
    [new Error("Authentication required: secret-token"), "connection_failed"],
  ] as const) {
    const result = diagnose(error, context);
    expect(result.code).toBe(code);
    expect(result.server).toBe("example");
    expect(result.operation).toBe("connect");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("private-path");
    expect(Object.keys(result).sort()).toEqual([
      "code",
      "hint",
      "message",
      "operation",
      "server",
    ]);
  }
});

test("local diagnostics survive wrapping and provide authentication-specific hints", () => {
  const result = diagnose(failure("secret_lookup_failed", { operation: "connect" }), {
    ...context,
    operation: "search",
  });
  expect(result.code).toBe("secret_lookup_failed");
  expect(result.operation).toBe("connect");
  expect(result.server).toBe("example");
  expect(diagnose(new DiagnosticError(result), context)).toEqual(result);
  expect(diagnose(new UnauthorizedError(), context).hint).toBe(
    "Run /mcp login example.",
  );
  expect(
    diagnose(new UnauthorizedError(), { ...context, oauth: false }).hint,
  ).toContain("Authorization header");
});

test("cancellation, callback-port conflicts, and unknown errors have safe fallbacks", () => {
  const signal = AbortSignal.abort(new Error("secret-token"));
  expect(diagnose(new Error("private"), { ...context, signal }).code).toBe("cancelled");
  expect(
    diagnose(new Error("private"), {
      ...context,
      signal: AbortSignal.abort(new DOMException("secret-token", "TimeoutError")),
    }).code,
  ).toBe("timeout");
  expect(
    diagnose(Object.assign(new Error("private"), { code: "EADDRINUSE" }), {
      operation: "auth",
    }).code,
  ).toBe("callback_unavailable");
  expect(
    diagnose(new SyntaxError("secret-token"), { operation: "configuration" }).code,
  ).toBe("configuration_invalid");
  expect(
    diagnose(
      { message: "secret-token", code: "REQUEST_TIMEOUT" },
      { operation: "call" },
    ).code,
  ).toBe("operation_failed");
  const cyclic = new Error("secret-token");
  cyclic.cause = cyclic;
  expect(diagnose(cyclic, context).code).toBe("connection_failed");
  const value = diagnostic("operation_failed", {
    server: "evil\nsecret-token",
    operation: "search",
  });
  expect(value.server).toBeUndefined();
  expect(formatDiagnostic(value)).not.toContain("secret-token");
});
