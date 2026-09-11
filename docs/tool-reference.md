# Model tool reference

[Back to the README](../README.md)

This page documents **the model's interface**. The examples illustrate tool
calls the model makes; they aren't slash commands or JavaScript for you to
run. Describe your task in natural language. For operations you control directly,
see [Commands](commands.md).

The `mcp_tools` tool supports four mutually exclusive operations:

| Operation | What the model can do | What it doesn't do |
| --- | --- | --- |
| `query` | Discover tool, resource, and prompt metadata. | Read content or activate tools. |
| `activate` | Load full schemas for exact tool identifiers. | Invoke tools. |
| `read` | Fetch one resource as conversation context. | Activate tools or follow links automatically. |
| `complete` | Request server suggestions for a template variable. | Read resources, activate tools, or select a value. |

The model passes exactly one of `query`, `activate`, `read`, or `complete`.
The optional `kind`, `server`, and `limit` fields are query-only; reads and
completions carry their server inside their respective objects.

## Discover capabilities

```js
// Search tool and resource metadata on one server.
mcp_tools({ query: "database schema", server: "warehouse", limit: 5 })

// Restrict one search to tools.
mcp_tools({ query: "list teams", server: "linear", kind: "tools" })
```

`kind` defaults to `all`, or accepts `tools`, `resources`, and `prompts`. Discovery
returns up to five candidates by default, or up to 50 with `limit`, across all kinds.

Tool candidates show an exact activation identifier, a short description,
required parameter names only, and `[loaded]` if already active. Resource
candidates show the owning server, title or name, exact URI, description, and
content type when supplied. Concrete resources and tools include exact next-call
arguments; templates include a read-call shape and variable names.

Prompt candidates show the owning server, name, description, argument metadata,
and a user-only command such as `/mcp prompt docs explain`. The model can
recommend this command but can't retrieve or run prompts through `mcp_tools`.
Only you can [select, preview, and use a prompt](commands.md#use-server-prompts).

```js
// Discover prompt metadata without fetching the prompt content.
mcp_tools({ query: "explain authentication", server: "docs", kind: "prompts" })
```

Search uses local BM25-based ranking of metadata, with names and resource titles
weighted more strongly than descriptions, and support for prefix matching.
Resource and prompt content isn't fetched or searched. See
[discovery and caching](behavior.md#discovery-and-caching) for connection behavior.

## Activate and call tools

```js
mcp_tools({ activate: ["linear.list_teams", "linear.get_team"] })
```

Activation accepts 1–50 exact `server.tool` or `mcp__server__tool` identifiers,
ignores duplicates, and works without a prior search. Typos never activate fuzzy
matches: failures list nearby catalog names when available so the model can
retry with an exact identifier. Each identifier reports `loaded`, `already loaded`,
or `not loaded` with a reason. Partial success keeps the tools that loaded.

Full schemas become available on the model turn after activation. When discovery
is needed, first use follows three steps: discover, activate, then call the native
tool. There is no invocation proxy. Previously loaded tools remain available;
[session behavior](behavior.md#sessions) describes restoration and tool restrictions.

## Read resources as context

For a request such as “Use the authentication guide to explain this API,” the
model can discover and read relevant context:

```js
mcp_tools({ query: "authentication guide", kind: "resources" })
mcp_tools({ read: { server: "docs", uri: "docs://authentication" } })
```

A read fetches one exact resource URI through its configured server's MCP
`resources/read` operation. It doesn't open a local file or make a generic HTTP
request, even for `file:` or `https:` URIs. There is no fallback when the server
can't read the URI. The server still controls which data it returns.

Tool-returned resource links include an exact `mcp_tools({read: ...})` call. The
model can read such links directly, without prior discovery or activation;
linked resources don't have to appear in the catalog.

Reading attaches content as the tool result itself, not as a second message. The
result identifies the source server and URIs and labels the content as untrusted
data. See [resource snapshots](behavior.md#resource-snapshots) for freshness and
session privacy, and [large results](troubleshooting.md#large-results) for output
limits and private spill files.

## Read parameterized resources

Discovery also lists URI templates, such as `schema://tables/{table}`, without
enumerating every possible table. Templates have a `[template]` label, variable
names, and a read-call shape. The model supplies known argument values:

```js
mcp_tools({ query: "table schema", server: "warehouse", kind: "resources" })
mcp_tools({
  read: {
    server: "warehouse",
    template: "schema://tables/{table}",
    arguments: { table: "events" }
  }
})
```

The `read` object accepts either `uri` or `template` plus `arguments`, never both.
The selected server must advertise the exact template. The official SDK expands
strings or string arrays into a concrete URI, then reads it through that same
server. Template variables aren't an input schema: no required fields or allowed
values are inferred. The model should use values from your request or prior
results and ask you when a needed value is unknown rather than inventing an
identifier.

Argument data is limited to 64 KiB and expanded URIs to 4,096 characters. Template
reads share exact reads' authorization, cancellation, output limits, and snapshot
rules. Expanded output includes the template, supplied arguments, and resource
content; see [result display](behavior.md#result-display).

## Complete resource arguments

The model can ask a server for suggested values for one advertised template
variable:

```js
mcp_tools({
  complete: {
    server: "warehouse",
    template: "schema://tables/{table}",
    argument: { name: "table", value: "ev" }
  }
})
```

`value` is the current prefix and can be empty. For dependent suggestions, the
model can add `arguments: { knownVariable: "value" }` inside `complete`.
These context values must be strings, not arrays. The server must advertise
completion support and the exact template; the variable must occur in that
template.

The result contains `values` and, when supplied by the server, `total` and
`hasMore`. A narrower prefix can reduce the matches. Suggestions are untrusted
server data, not a required-field schema or instructions. Requests are limited
to 64 KiB; output uses the same [limits and spill files](troubleshooting.md#large-results)
as other results.

Resource subscriptions aren't part of this tool. Only you can
[watch resource changes](commands.md#watch-resource-changes) with `/mcp` commands.
