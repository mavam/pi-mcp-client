# Post-v0.1 backlog

v0.1 focuses on on-demand native tool discovery and invocation over stdio and
Streamable HTTP. This is a prioritized backlog, not a promise that every feature
will ship or a schedule for v0.2. MCP capabilities are negotiated and optional;
not every server or client needs all of them.

## High priority: broader server compatibility

- [ ] **Resources:** List, search, and read resources; expand resource templates;
  attach selected content to a conversation without loading it all into context.
  Existing handling of resource content returned by tools is not resource browsing.
- [ ] **Prompts:** Discover and run server-provided prompts with argument entry and
  explicit user selection. Treat prompt content as untrusted server data.
- [ ] **Roots:** Advertise explicitly authorized workspace roots and notify servers
  when they change. Roots are scope hints, not a filesystem sandbox.
- [x] **Tool catalog notifications:** Handle `tools/list_changed` and invalidate
  stale catalogs without silently replacing an active tool contract.
- [ ] **Resource and prompt catalog notifications:** Extend notification handling
  when those capabilities are implemented.
- [ ] **OAuth interoperability:** Support pre-registered clients and additional
  client-registration mechanisms where supported by the SDK and server. Preserve
  issuer binding and OS-backed credential storage.
- [ ] **Credential management:** Add logout and credential removal, plus token
  revocation when supported. Make it clear which account or grant is in use
  without exposing tokens.

## High priority: everyday client management

- [x] **Server inspection and reload:** Inspect servers, browse tools, and reload
  configuration without restarting Pi; close connections and reconcile loaded tools.
- [x] **Server enable/disable commands:** Toggle servers without editing configuration.
- [ ] **Configuration imports:** Offer explicit, previewable imports from Claude,
  Cursor, VS Code, Codex, and MCPorter. Never silently merge credentials or execute
  imported commands.
- [ ] **Cache controls:** Inspect and clear catalogs, configure freshness, and show
  whether discovery used a cached or live catalog.
- [ ] **Permission controls:** Offer per-server/tool confirmation policies or a
  documented integration with Pi's permission system. Tool annotations are hints,
  not authority to bypass approval.
- [ ] **Diagnostic inspection:** Add safe per-server health checks and more precise
  configuration locations. Any diagnostic export must be opt-in and exclude raw
  credentials, command output, and transport payloads by default.
- [ ] **Result-file cleanup:** Provide retention controls and explicit cleanup for
  private spill files, without deleting files still referenced by a session.

## Interactive MCP capabilities

- [ ] **Elicitation:** Handle supported server requests for user input, with explicit
  consent and clear cancellation or refusal in non-interactive sessions.
- [ ] **Sampling:** Handle server requests for model generation with user approval,
  model and cost limits, and control over which conversation context is shared.
- [ ] **MCP Apps:** Investigate a suitable host for interactive tool interfaces.
  Require origin isolation and a permissions model; do not execute arbitrary
  server HTML inside the terminal.
- [ ] **Long-running work:** Expose task or continuation workflows supported by the
  negotiated protocol, including progress, cancellation, and resumption. Do not
  duplicate work after an ambiguous disconnect.

## Compatibility and operations

- [ ] **Remote/headless OAuth:** Support an explicit callback handoff or remote
  authentication workflow, rather than assuming the browser can reach Pi's local
  loopback listener.
- [ ] **Legacy SSE:** Evaluate an explicitly selected legacy transport for existing
  deployments. Keep Streamable HTTP as the recommended HTTP transport and never
  reinterpret an unsupported transport silently.
- [ ] **Recovery policy:** Define bounded connection backoff and idle cleanup around
  SDK transport behavior. Never automatically replay failed tool invocations.
- [ ] **Platform coverage:** Validate packaged installs, native keyrings, secret
  command execution, process cleanup, and browser launch on macOS, Linux, and
  Windows, including headless Linux environments.
- [ ] **Interoperability suite:** Maintain representative real-server tests across
  authentication modes and protocol versions, without live credentials in CI.

## Keep out of scope unless a concrete use case requires it

- An invocation proxy in place of native Pi tools.
- Loading every server's tool schema into every prompt.
- Background browser authentication without an explicit user action.
- Plaintext OAuth credential storage as a fallback for an unavailable keyring.
