# Behavior and permissions

[Back to the README](../README.md)

This page explains how the extension manages state and displays results. For the
assistant's tool-call interface, see the [tool reference](tool-reference.md).

## Sessions

- Active tools accumulate rather than rotating with each prompt.
- Resume and branch navigation restore tools activated through `mcp_tools` on
  the selected branch. Discovery results never restore tools.
- Compaction retains the acquired tool set. New sessions start fresh.
- Pi uses native deferred loading where supported by the model and provider.
  Other providers receive the expanded tool list normally.
- Discovery respects server filters; activation also respects Pi's tool exclusions.
  An explicit tool allowlist must include both `mcp_tools` and the native tools
  the assistant needs to load.

## Resource snapshots

Resource reads never start OAuth login, follow links in resource bodies, or
subscribe to live updates. Repeated reads fetch fresh content; earlier results
stay as snapshots. Resuming a session or navigating its branches doesn't re-read
resources. Watches have their own
[memory-only lifecycle](commands.md#watch-resource-changes) and never fetch content
automatically.

Resource content and selected metadata, including URIs, become session data and
may be sensitive. [Private spill files](troubleshooting.md#large-results) can also
contain sensitive data and aren't automatically deleted.

## Prompt snapshots

Prompt discovery fetches metadata only. You explicitly enter arguments and fetch a
preview through `/mcp prompts` or `/mcp prompt`. Only **Use prompt** adds the
reviewed snapshot to the conversation and starts a model turn. Cancelling a
preview adds no message and doesn't write a spill file. Arguments already sent to
the server can't be recalled.

The transcript labels accepted snapshots **mcp prompt** with their server, name,
and message count. Expand the entry to inspect its contents. Server-provided
`user` and `assistant` roles remain fields in source-labeled data, not fabricated
conversation history or system instructions. Terminal control sequences are
removed before previewing and sending text. Selecting a prompt grants no additional
tool permissions and never activates tools.

Previously accepted snapshots don't change or refetch on catalog notifications,
resume, or branch navigation. Session replacement, tree navigation, and
configuration reload invalidate pending selections. The agent must be idle when
you choose **Use prompt**; another active turn is never silently interrupted.
Accepted content becomes session data and may contain sensitive information.

## Discovery and caching

Connections start on demand, never while the extension factory loads. A search
without the requested cached metadata contacts configured servers, with at most
four server discoveries in flight. A server-scoped search only contacts that
server. Activation discovers only the servers named by its identifiers, with the
same concurrency bound. Failed servers are reported as unavailable, not mistaken
for an empty catalog.

Tool catalogs are cached privately under `~/.pi/agent/cache/pi-mcp-client/`, keyed
by server configuration and working directory. Disk caches expire after 24 hours.
They contain tool metadata, not configured credentials. Cached tool-only discovery
and activation need no connection; invocation refreshes the live catalog before
calling the tool.

Resource metadata, including template catalogs, and prompt metadata are held only
in memory for up to five minutes, not written to the tool catalog cache. Mixed
discovery therefore may connect even when tools are cached on disk. Resource-list notifications,
disconnection, and explicit refresh invalidate resource metadata without reading
content. Tool and resource catalog failures are reported independently; healthy
candidates remain available. The SDK handles pagination. Resource catalogs are
limited to 10,000 entries and 4 MiB of descriptor data; oversized catalogs fail
rather than silently returning a partial list. Reads bypass the SDK content cache.

Prompt-list notifications invalidate only prompt metadata; they never fetch prompt
content or change a pending preview. Disconnection and explicit refresh also
invalidate prompt metadata. Prompt catalog failures don't suppress healthy
tool or resource candidates. The SDK handles prompt pagination. Prompt catalogs
share the 10,000-entry and 4 MiB limits and reject invalid or duplicate descriptors
rather than presenting a partial catalog.

Connections remain open until shutdown or an explicit lifecycle action such as
reconnection or configuration reload.

When a connected server reports a tool-list change, the extension invalidates its
memory and disk catalogs. The next discovery or activation fetches the current
list, including new or removed tools. Notifications don't replace active tool
definitions: the assistant must activate changed schemas again before use. Calls
validate the live catalog before execution and refuse removed or changed tools.
Disconnected, cache-only searches can't receive notifications and still use the
24-hour disk-cache expiry.

## Result display

The UI labels discovery calls **mcp discover**, activation calls **mcp activate**,
resource reads **mcp read**, and argument completions **mcp complete**.

Discovery rows show `○` for inactive candidates and `●` for already active tools,
without a status suffix. These reflect the state when discovery runs; earlier
results don't update retroactively. Activation results use `✔︎` for success and
`✘︎` for failure. Descriptions stay gray; identifiers remain prominent.

Exact and template reads use the same compact status row:

```text
mcp read
 ✔︎ warehouse · schema://tables/events
```

Expand a tool result to see JSON objects and arrays formatted with two-space
indentation and syntax highlighting. Explicit JSON resource MIME types (including
`application/*+json`) and structured content identify JSON without guessing.
Other explicit MIME types stay plain text; unlabeled text is checked for JSON.

Formatting changes only the display, not the response sent to the assistant.
Invalid or truncated JSON stays plain text. Results that would exceed formatting
limits also stay plain text. Resource-link MIME types describe the linked content,
not the displayed link label. Supported images use the existing result display;
see [large results](troubleshooting.md#large-results) for size limits.

## Trust and permissions

Only load configuration you trust. Server executables and secret commands run
with your user permissions; trusted project configuration can replace global
connections and settings.

Server metadata, resource content, and prompt content are untrusted data. Discovery never
activates tools. Explicit activation exposes schemas but doesn't approve tool
side effects or provide per-call confirmation. Use tool filters and Pi permission
extensions for additional controls. Cancelling a call doesn't guarantee that the
server rolled back its effects. The extension doesn't retry failed tool
invocations; verify an interrupted operation's outcome before trying again.

`includeTools` and `excludeTools` apply only to tools, not resources or prompts. Keeping
`mcp_tools` available permits resource reads from enabled servers, subject to the
server's authorization. `kind: "tools"` filters one search; it isn't an access
restriction. Disable a server to prevent all access, or exclude `mcp_tools` through
Pi's tool restrictions to prevent discovery and resource operations. Already active
native tools have their own tool restrictions. Per-resource permission policies
aren't implemented. Prompt selection uses explicit user commands, not the
model-facing tool allowlist; disable the server to prevent prompt access.
