import {
  OAuthClientFlowError,
  OAuthError,
  RegistrationRejectedError,
  InsecureTokenEndpointError,
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
  prompts_unsupported: "The server does not advertise prompts.",
  prompt_not_found: "The prompt is no longer available or was not found.",
  prompt_invalid: "The prompt arguments do not match the advertised arguments or exceed their limits.",
  prompt_too_large: "The prompt exceeds 2000 lines or 50 KiB and cannot be used. No content was attached.",
  resources_unsupported: "The server does not advertise resource access.",
  completions_unsupported: "The server does not advertise argument completions.",
  completion_invalid: "The resource completion arguments are invalid.",
  subscriptions_unsupported: "The server did not accept resource subscriptions.",
  subscription_limit: "The connection has reached its limit of 50 resource subscriptions.",
  catalog_changed: "The catalog kept changing during discovery.",
  oauth_failed: "OAuth authentication did not complete.",
  oauth_client_required: "OAuth requires a registered client: this server does not support dynamic client registration.",
  oauth_registration_rejected: "The authorization server rejected OAuth client registration.",
  oauth_client_rejected: "The authorization server rejected the OAuth client or its authentication method.",
  oauth_pkce_unsupported: "The authorization server does not support the required S256 PKCE method.",
  oauth_scope_rejected: "The authorization server rejected the requested OAuth scopes.",
  oauth_grant_rejected: "The OAuth authorization code or refresh token was rejected.",
  oauth_redirect_rejected: "The authorization server rejected the OAuth callback URL.",
  oauth_endpoint_insecure: "The OAuth token endpoint is not secure.",
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
  | "prompt"
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
    prompts_unsupported: "Select a server with prompt support.",
    prompt_not_found: "Browse the current prompt catalog and select an exact name.",
    prompt_invalid: "Review the argument names, required values, and size limits.",
    prompt_too_large: "Request a smaller prompt from the server.",
    resources_unsupported: "Use this server's tools instead, or select a server with resource support.",
    completions_unsupported: "Supply known template values or ask the user for them.",
    completion_invalid: "Use an advertised resource template and one of its variable names, with a string prefix and optional known string arguments.",
    subscriptions_unsupported: "Choose a server with resource subscription support, or read the resource explicitly when needed.",
    subscription_limit: "Unsubscribe from another resource before adding a new watch.",
    catalog_changed: "Retry discovery once the server catalog has settled.",
    oauth_failed: `Check the service's OAuth requirements and /mcp get ${target} for the client type, requested scopes, and callback address. Only public clients with PKCE are supported; clients requiring a client secret are not. Retry /mcp login ${target} after correcting the setup.`,
    oauth_client_required: `Configure oauthClientId with a registered public/PKCE client ID in this server's definition. Register the exact callback URL shown by /mcp get ${target}, then run /mcp reload and /mcp login ${target}. Clients requiring a client secret are not supported. --no-browser does not fix client registration.`,
    oauth_registration_rejected: `Check whether the service allows public/native client registration and the callback URL shown by /mcp get ${target}. If registration is restricted, configure an approved public client with oauthClientId, run /mcp reload, then retry /mcp login ${target}.`,
    oauth_client_rejected: `Verify oauthClientId, the app's approval, and support for public-client authentication (token endpoint method none). Clients requiring a client secret are not supported. After configuration changes, run /mcp reload and /mcp login ${target}.`,
    oauth_pkce_unsupported: "Use an authorization server or app configuration that supports authorization-code login with S256 PKCE. This client cannot fall back to login without PKCE.",
    oauth_scope_rejected: `Check oauthScopes against the service's allowed scopes and app permissions. Run /mcp reload after changes, then /mcp login ${target}.`,
    oauth_grant_rejected: `Run /mcp login ${target} for a fresh authorization code. If it fails again, verify the registered client and exact callback URL shown by /mcp get ${target}.`,
    oauth_redirect_rejected: `Register the exact callback URL shown by /mcp get ${target}, including its host, port, and /callback path. --no-browser uses the same callback URL and does not bypass redirect validation.`,
    oauth_endpoint_insecure: "Use an authorization server with an HTTPS token endpoint. HTTP is only allowed for loopback endpoints; do not disable TLS verification.",
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

/** Exact SDK fallbacks for failures that have no typed error in SDK 2.0.0.
 * Never echo messages or match fragments: arbitrary server text stays private.
 */
function sdkOAuthFallback(error: Error): DiagnosticCode | undefined {
  if (error.constructor !== Error) return;
  switch (error.message) {
    case "Incompatible auth server: does not support dynamic client registration":
      return "oauth_client_required";
    case "Incompatible auth server: does not support code challenge method S256":
      return "oauth_pkce_unsupported";
    case "client_secret_basic authentication requires a client_secret":
      return "oauth_client_rejected";
  }
}

/** Classify SDK errors and allowlisted codes without exposing raw payloads. */
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
    if (current instanceof RegistrationRejectedError)
      return diagnostic("oauth_registration_rejected", context);
    if (current instanceof InsecureTokenEndpointError)
      return diagnostic("oauth_endpoint_insecure", context);
    if (current instanceof OAuthError) {
      switch (current.code) {
        case "invalid_client":
        case "unauthorized_client":
          return diagnostic("oauth_client_rejected", context);
        case "invalid_scope":
        case "insufficient_scope":
          return diagnostic("oauth_scope_rejected", context);
        case "invalid_grant":
          return diagnostic("oauth_grant_rejected", context);
        case "invalid_redirect_uri":
          return diagnostic("oauth_redirect_rejected", context);
        case "access_denied":
          return diagnostic("permission_denied", context);
      }
      return diagnostic("oauth_failed", context);
    }
    if (current instanceof OAuthClientFlowError)
      return diagnostic("oauth_failed", context);
    if (context.operation === "auth" || context.oauth) {
      const code = sdkOAuthFallback(current);
      if (code) return diagnostic(code, context);
    }
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
