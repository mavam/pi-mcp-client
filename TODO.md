# Post-v0.1 backlog

v0.1 focuses on on-demand native tool discovery and invocation over stdio and
Streamable HTTP. This is a prioritized backlog, not a promise that every feature
will ship or a schedule for v0.2. MCP capabilities are negotiated and optional;
not every server or client needs all of them.

## CLI parity with Codex and Claude Code

Use familiar command names without copying client-specific behavior. Inspection
stays redacted, discovery never activates tools, and authentication stays explicit.

- [x] **Command terminology:** Use `/mcp list`, `/mcp get <server>`, and
  `/mcp login <server>`. The former `inspect` and `auth` names are not aliases.
- [x] **Credential lifecycle:** `/mcp logout <server>` and safe authentication
  status in `/mcp get`, including disabled servers. Logout preserves configuration,
  distinguishes local removal from remote revocation, and explains externally
  managed credentials without changing them.
- [x] **Pre-registered OAuth clients:** `oauthClientId` supports public clients on
  servers without dynamic registration, with issuer binding and separate OS-backed
  credentials per configured client ID.
- [x] **Configuration commands:** `/mcp add` and `/mcp remove` require explicit
  scope selection and validate before saving. Adding never executes a server;
  removing configuration retains credentials and is distinct from disabling.
- [x] **OAuth options:** Requested scopes, configurable loopback callback ports,
  and browser-free callback handoff. Non-interactive login is explicitly refused.

References: [Codex CLI](https://developers.openai.com/codex/cli/reference#codex-mcp)
and [Claude Code MCP](https://code.claude.com/docs/en/mcp).

## High priority: broader server compatibility

- [x] **Resources:** Discover tool and resource metadata together, then read selected
  resources as bounded conversation context. Exact tool-returned resource links
  can be read without prior discovery. No manual resource browser is required.
- [x] **Resource templates:** Discover template metadata and read parameterized
  resources through SDK URI expansion, without inferred argument schemas.
- [x] **Resource completions and subscriptions:** Request server-provided template
  argument completions and explicitly watch resource changes without fetching
  content or replacing attached snapshots. Watches are connection-local and
  never restored automatically.
- [x] **Prompts:** Discover and run server-provided prompts with argument entry and
  explicit user selection. Treat prompt content as untrusted server data.
- [ ] **Roots:** Advertise explicitly authorized workspace roots and notify servers
  when they change. Roots are scope hints, not a filesystem sandbox.
- [x] **Tool catalog notifications:** Handle `tools/list_changed` and invalidate
  stale catalogs without silently replacing an active tool contract.
- [x] **Resource catalog notifications:** Invalidate resource metadata without
  fetching content or changing active tools.
- [x] **Prompt catalog notifications:** Invalidate prompt metadata without fetching
  content or changing previews and accepted snapshots.
- [ ] **Additional OAuth interoperability:** Support confidential pre-registered
  clients and client ID metadata documents where supported by the SDK and server.
  Public pre-registered clients are implemented. Preserve issuer binding and
  OS-backed credential storage.
- [x] **Credential management:** Logout, credential removal, and best-effort token
  revocation when supported, with safe stored-credential status.
- [ ] **Account and grant identity:** Show verified account or grant information
  when supplied by the service, without exposing tokens or inferring identity
  from unverified token claims.

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

- [x] **Remote/headless OAuth:** Explicit interactive callback handoff with
  `/mcp login <server> --no-browser`, without assuming the browser can reach Pi's
  local loopback listener. Unattended login remains unsupported.
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
