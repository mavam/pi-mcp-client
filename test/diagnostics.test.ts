import { expect, test } from "bun:test";
import {
  OAuthError,
  OAuthClientFlowError,
  RegistrationRejectedError,
  InsecureTokenEndpointError,
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

const authContext = { server: "slack", operation: "auth" } as const;
const missingRegistration = "Incompatible auth server: does not support dynamic client registration";

test("OAuth diagnostics identify actionable causes without exposing SDK payloads", () => {
  for (const [error, code] of [
    [new Error(missingRegistration), "oauth_client_required"],
    [new Error("Incompatible auth server: does not support code challenge method S256"), "oauth_pkce_unsupported"],
    [new Error("client_secret_basic authentication requires a client_secret"), "oauth_client_rejected"],
    [new OAuthError("invalid_client", "secret-token", "https://private.example"), "oauth_client_rejected"],
    [new OAuthError("unauthorized_client", "secret-token"), "oauth_client_rejected"],
    [new OAuthError("invalid_scope", "secret-token"), "oauth_scope_rejected"],
    [new OAuthError("insufficient_scope", "secret-token"), "oauth_scope_rejected"],
    [new OAuthError("invalid_grant", "secret-token"), "oauth_grant_rejected"],
    [new OAuthError("invalid_redirect_uri", "secret-token"), "oauth_redirect_rejected"],
    [new OAuthError("access_denied", "secret-token"), "permission_denied"],
    [new InsecureTokenEndpointError("http://private.example/secret-token"), "oauth_endpoint_insecure"],
    [new RegistrationRejectedError({
      status: 400,
      body: "secret-token",
      submittedMetadata: { redirect_uris: ["https://private.example"] },
    }), "oauth_registration_rejected"],
    [new OAuthClientFlowError("secret-token"), "oauth_failed"],
    [new OAuthError("secret-token", "secret-token"), "oauth_failed"],
  ] as const) {
    for (const wrapped of [error, new Error("private wrapper", { cause: error })]) {
      const result = diagnose(wrapped, authContext);
      expect(result.code).toBe(code);
      expect(result.server).toBe("slack");
      expect(JSON.stringify(result)).not.toMatch(/secret-token|private\.example|private wrapper/);
      expect(diagnose(new DiagnosticError(result), authContext)).toEqual(result);
    }
  }
  const result = diagnose(new Error(missingRegistration), authContext);
  expect(result.hint).toContain("oauthClientId");
  expect(result.hint).toContain("/mcp get slack");
  expect(result.hint).toContain("/mcp reload and /mcp login slack");
});

test("OAuth message fallbacks are exact, contextual, and never echo unknown errors", () => {
  for (const error of [
    new Error(`${missingRegistration}: secret-token`),
    new TypeError(missingRegistration),
    new OAuthError("unknown", missingRegistration),
    new Error("secret-token"),
  ]) {
    const result = diagnose(error, authContext);
    expect(result.code).toBe("oauth_failed");
    expect(result.hint).not.toContain("--no-browser");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  }
  expect(diagnose(new Error(missingRegistration), { operation: "call" }).code).toBe("operation_failed");
  expect(diagnose(new Error(missingRegistration), context).code).toBe("oauth_client_required");
  expect(diagnose(new Error(missingRegistration), {
    ...authContext, signal: AbortSignal.abort(),
  }).code).toBe("cancelled");
});

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
