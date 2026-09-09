import {
  OAuthClientFlowError,
  OAuthError,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  SdkError,
  SdkHttpError,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

const messages = {
  configuration_invalid: "Configuration is invalid or incomplete.",
  authentication_required: "Authentication is required.",
  permission_denied: "Access was denied.",
  credential_store_unavailable: "The OS credential store could not be accessed.",
  secret_lookup_failed: "A secret command failed or exceeded its limits.",
  timeout: "The operation timed out.",
  cancelled: "The operation was cancelled.",
  connection_failed: "The server connection failed.",
  protocol_error: "The server response or protocol is not supported.",
  server_unknown: "The MCP server is not configured.",
  server_disabled: "The MCP server is disabled.",
  tool_changed: "The tool is unavailable or its configuration or schema changed.",
  tool_error: "The tool reported an error.",
  resource_invalid: "The resource URI is invalid.",
  resource_not_found: "The resource is no longer available or was not found.",
  resources_unsupported: "The server does not advertise resource access.",
  completions_unsupported: "The server does not advertise argument completions.",
  completion_invalid: "The resource completion arguments are invalid.",
  subscriptions_unsupported: "The server did not accept resource subscriptions.",
  subscription_limit: "The connection has reached its limit of 50 resource subscriptions.",
  catalog_changed: "The catalog kept changing during discovery.",
  oauth_failed: "OAuth authentication did not complete.",
  oauth_issuer_changed: "The OAuth authorization server changed.",
  callback_unavailable: "The local OAuth callback port is unavailable.",
  busy: "Discovery is still running.",
  operation_failed: "The operation failed.",
} as const;
export type DiagnosticCode = keyof typeof messages;
export type Operation =
  | "configuration"
  | "connect"
  | "search"
  | "call"
  | "read"
  | "complete"
  | "subscribe"
  | "auth"
  | "reconnect"
  | "refresh";
export interface DiagnosticContext {
  server?: string;
  operation: Operation;
  oauth?: boolean;
  signal?: AbortSignal;
}
export interface Diagnostic {
  code: DiagnosticCode;
  operation: Operation;
  server?: string;
  message: string;
  hint: string;
}

export function diagnostic(
  code: DiagnosticCode,
  context: DiagnosticContext,
): Diagnostic {
  // Server names are configuration identifiers, never raw error properties.
  const server =
    context.server && /^[A-Za-z0-9_-]{1,80}$/.test(context.server)
      ? context.server
      : undefined;
  const target = server ?? "<server>";
  const hints: Record<DiagnosticCode, string> = {
    configuration_invalid:
      "Check mcpServers in mcp.json / .mcp.json, including inline server options and environment variables. Move options from any top-level pi section into mcpServers.<server>. Reload Pi after editing.",
    authentication_required: context.oauth
      ? `Run /mcp login ${target}.`
      : `For OAuth, run /mcp login ${target}. If you use an Authorization header, check its credentials instead.`,
    permission_denied:
      "Check the account's permissions, OAuth scopes, and service access policy.",
    credential_store_unavailable:
      "Unlock or enable the OS keyring. Linux requires a Secret Service session; there is no plaintext fallback.",
    secret_lookup_failed:
      "Check the secret helper's availability, login, exit status, and nonempty stdout. The limit is 64 KiB and at most 10 seconds.",
    timeout:
      "Check server responsiveness and timeoutMs. Secret lookups and OAuth have separate time limits.",
    cancelled: "Start the operation again when ready.",
    connection_failed: `Check the URL or executable, working directory, network, and TLS setup; then run /mcp reconnect ${target}.`,
    protocol_error:
      "Check the server's MCP compatibility and protocol setting. Only stdio and Streamable HTTP are supported.",
    server_unknown:
      "Choose a configured MCP server from the capability directory or run /mcp to list servers. Omit server in mcp_tools to search all enabled servers.",
    server_disabled:
      `Run /mcp enable ${target}, or omit server in mcp_tools to search all enabled servers.`,
    tool_changed:
      "Check server filters and use mcp_tools with activate and the exact identifier to activate the current tool definition. Reload Pi if the connection configuration changed.",
    tool_error:
      "Review the server's tool result and inputs. Verify the outcome before retrying.",
    resource_invalid: "Use an exact absolute resource URI from discovery or a tool-returned resource link.",
    resource_not_found: `Refresh with /mcp refresh ${target}, or obtain a new resource link.`,
    resources_unsupported: "Use this server's tools instead, or select a server with resource support.",
    completions_unsupported: "Supply known template values or ask the user for them.",
    completion_invalid: "Use an advertised resource template and one of its variable names, with a string prefix and optional known string arguments.",
    subscriptions_unsupported: "Choose a server with resource subscription support, or read the resource explicitly when needed.",
    subscription_limit: "Unsubscribe from another resource before adding a new watch.",
    catalog_changed: "Retry discovery once the server catalog has settled.",
    oauth_failed: `Check OAuth support, the configured public client ID, and callback access. Retry /mcp login ${target}, or use /mcp login ${target} --no-browser for manual callback handoff.`,
    oauth_issuer_changed: `Verify the server configuration before running /mcp logout ${target} and /mcp login ${target} to trust the new authorization server.`,
    callback_unavailable: `Free the configured callback port, change oauthCallbackPort, or run /mcp login ${target} --no-browser.`,
    busy: "Wait for the current MCP operation to finish, then retry.",
    operation_failed:
      "Check /mcp for server status and verify the server configuration.",
  };
  return {
    code,
    operation: context.operation,
    ...(server ? { server } : {}),
    message: messages[code],
    hint: hints[code],
  };
}

/** Only constructed from local diagnostic codes; never carries a raw cause. */
export class DiagnosticError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(formatDiagnostic(diagnostic));
    this.name = "DiagnosticError";
  }
}
export function failure(
  code: DiagnosticCode,
  context: DiagnosticContext,
): DiagnosticError {
  return new DiagnosticError(diagnostic(code, context));
}
export function formatDiagnostic(value: Diagnostic): string {
  return `${value.server ? `${value.server}: ` : ""}[${value.code}] ${value.message} ${value.hint}`;
}

/** Classify typed SDK errors and allowlisted OS codes, never error-message text. */
export function diagnose(error: unknown, context: DiagnosticContext): Diagnostic {
  if (context.signal?.aborted)
    return diagnostic(
      context.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
      context,
    );
  if (error instanceof DiagnosticError)
    return diagnostic(error.diagnostic.code, {
      ...context,
      operation: error.diagnostic.operation,
    });
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (current instanceof DiagnosticError)
      return diagnostic(current.diagnostic.code, context);
    if (current instanceof UnauthorizedError)
      return diagnostic("authentication_required", context);
    if (current instanceof SdkHttpError) {
      if (current.status === 401) return diagnostic("authentication_required", context);
      if (current.status === 403) return diagnostic("permission_denied", context);
    }
    if (current instanceof SdkError) {
      if (current.code === "REQUEST_TIMEOUT") return diagnostic("timeout", context);
      if (current.code === "CLIENT_HTTP_AUTHENTICATION")
        return diagnostic("authentication_required", context);
      if (current.code === "CLIENT_HTTP_FORBIDDEN")
        return diagnostic("permission_denied", context);
      if (
        [
          "INVALID_RESULT",
          "UNSUPPORTED_RESULT_TYPE",
          "CAPABILITY_NOT_SUPPORTED",
          "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION",
          "ERA_NEGOTIATION_FAILED",
          "CLIENT_HTTP_UNEXPECTED_CONTENT",
        ].includes(current.code)
      )
        return diagnostic("protocol_error", context);
      if (["NOT_CONNECTED", "CONNECTION_CLOSED", "SEND_FAILED"].includes(current.code))
        return diagnostic("connection_failed", context);
    }
    if (current instanceof OAuthClientFlowError || current instanceof OAuthError)
      return diagnostic("oauth_failed", context);
    if (current instanceof ProtocolError) return diagnostic(
      context.operation === "read" && (current instanceof ResourceNotFoundError || current.code === ProtocolErrorCode.ResourceNotFound) ? "resource_not_found" : "protocol_error", context,
    );
    if (current.name === "TimeoutError") return diagnostic("timeout", context);
    if (current.name === "AbortError") return diagnostic("cancelled", context);
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && context.operation === "auth")
      return diagnostic("callback_unavailable", context);
    if (
      code &&
      [
        "ENOENT",
        "EACCES",
        "ENOTDIR",
        "ECONNREFUSED",
        "ECONNRESET",
        "ENOTFOUND",
        "EAI_AGAIN",
        "CERT_HAS_EXPIRED",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      ].includes(code)
    )
      return diagnostic(
        context.operation === "configuration"
          ? "configuration_invalid"
          : "connection_failed",
        context,
      );
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT")
      return diagnostic("timeout", context);
    current = current.cause;
  }
  return diagnostic(
    context.operation === "configuration"
      ? "configuration_invalid"
      : context.operation === "connect"
        ? "connection_failed"
        : context.operation === "auth"
          ? "oauth_failed"
          : "operation_failed",
    context,
  );
}
