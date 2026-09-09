# Troubleshooting

[Back to the README](../README.md)

Start with `/mcp` to inspect server status and `/mcp get <server>` to inspect
configuration without connecting. Failures use a consistent code, a short
explanation, and a recovery hint, for example:

```text
linear: [authentication_required] Authentication is required. Run /mcp login linear.
```

## Diagnostic codes

Search and tool results also carry structured diagnostics in their result details:
`code`, `operation`, optional `server`, `message`, and `hint`. Partial discovery
keeps healthy servers' results and identifies servers it couldn't search. An
unavailable server isn't an empty catalog.

| Code | What to check |
| --- | --- |
| `configuration_invalid` | JSON syntax, supported fields, transport type, and required environment variables. Run `/mcp reload` after editing. |
| `authentication_required` | Run `/mcp login <server>` for OAuth, or check the Authorization header. |
| `permission_denied` | Account permissions, OAuth scopes, and service access policy. |
| `credential_store_unavailable` | Unlock or enable the OS keyring; Linux needs a Secret Service session. |
| `secret_lookup_failed` | Secret helper installation, login, exit status, nonempty stdout, and output size. |
| `connection_failed` | Server executable, working directory, endpoint, network, and TLS configuration. |
| `timeout` | Server responsiveness and the applicable request, secret-command, or OAuth time limit. |
| `protocol_error` | Server compatibility and the `protocol` setting. |
| `tool_changed` | Check server filters and ask the assistant to activate the exact tool again for its current schema. Run `/mcp reload` if connection configuration changed. |
| `tool_error` | The server's tool result and inputs; verify the outcome before retrying. |
| `resource_invalid` | The assistant needs an exact absolute resource URI from discovery or a tool-returned link. |
| `resource_not_found` | Refresh resource metadata or obtain a new link. |
| `resources_unsupported` | Ask the assistant to use the server's tools instead, or choose a resource-capable server. |
| `completions_unsupported` | Supply known template values; the assistant should ask you if a value is missing. |
| `completion_invalid` | The assistant needs an advertised template variable and a string prefix. |
| `subscriptions_unsupported` | Choose a server with subscription support, or ask the assistant to read when needed. |
| `subscription_limit` | Remove a watch before adding another; the limit is 50 per connection. |
| `catalog_changed` | Ask the assistant to retry discovery after the server catalog settles. |
| `oauth_failed` | An unclassified OAuth failure. Check the service's requirements and `/mcp get <server>` for the client type, scopes, and callback URL. Only public/PKCE clients are supported, not clients requiring a secret. |
| `oauth_client_required` | The server doesn't support dynamic registration. Configure `oauthClientId` for a registered public/PKCE client and register the exact callback URL. Reload, then log in again. |
| `oauth_registration_rejected` | The server rejected dynamic registration. Check public/native client eligibility and the callback URL, or configure an approved public client ID. |
| `oauth_client_rejected` | Check the client ID, app approval, and public-client authentication (token endpoint method `none`). A rejected client doesn't necessarily mean a client secret is required. |
| `oauth_pkce_unsupported` | The authorization server must support S256 PKCE. Login without PKCE isn't supported. |
| `oauth_scope_rejected` | Check `oauthScopes` against the service's allowed scopes and app permissions. Reload after changes, then log in again. |
| `oauth_grant_rejected` | Log in again for a fresh code. If it still fails, check the client and exact callback URL. |
| `oauth_redirect_rejected` | Register the exact callback host, port, and `/callback` path shown by `/mcp get <server>`. Manual login uses the same callback URL. |
| `oauth_endpoint_insecure` | The token endpoint must use HTTPS unless it is on loopback. Don't disable TLS verification. |
| `oauth_issuer_changed` | Verify the authorization-server change before logging out and logging in again. |
| `callback_unavailable` | Another process using the configured loopback port (default 19847). Change `oauthCallbackPort` or use `/mcp login <server> --no-browser`. |
| `busy` | Wait for discovery to finish before reconnecting. |
| `cancelled` | Retry when ready; verify any interrupted tool operation first. |
| `operation_failed` | An unclassified failure; inspect server status and configuration. |

If login fails before opening a browser, check client registration first.
For Slack, see [Slack setup requirements](authentication.md#slack-setup-requirements).
Use `--no-browser` for browser launch or callback reachability problems, not
registration failures. Diagnostics use known failure categories rather than
printing server error descriptions, which can contain credentials or private URLs.
An unknown error remains `oauth_failed`; it doesn't prove a callback problem.

For setup details, see [Configuration](configuration.md),
[Authentication](authentication.md), and [Commands](commands.md).

Diagnostics never echo raw exception messages, HTTP bodies, command stderr,
credential values, or stack traces. Unknown errors stay generic rather than being
classified by potentially sensitive message text. Server-provided tool results
remain visible as content, even when the tool reports an error; they aren't
sanitized transport diagnostics. Tool-call failures aren't replayed automatically;
verify the outcome before retrying.

## Large results

Text output is limited to 2,000 lines or 50 KiB, including resource reads and
completions. Larger results are saved in private temporary files, with paths
included in the output. Full tool results use JSON files. Supported images pass
through within an 8 MiB base64 budget; unsupported or oversized binary content is
retained in the full result file.

A resource read fetches the server's full response before applying output limits;
it isn't a streaming or partial-content reader. Temporary result files aren't
automatically deleted and may contain sensitive data.
