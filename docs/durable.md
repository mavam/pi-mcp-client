# Pi Durable

[Back to the README](../README.md)

The experimental adapter requires Pi Durable 1.0. It reuses the MCP SDK runtime,
configuration, OS-backed OAuth credentials, catalog cache, and bounded result
conversion. It does not load the normal Pi extension.

## Install in a host

```ts
import { createMcpExtension } from "pi-mcp-client/durable";

const mcp = await createMcpExtension({ registry, cwd: process.cwd() });
registry.install(mcp.extension);
const harness = await Harness.open(storage, { models, registry }, context);
await mcp.restore(harness, context);
// Give each new conversation an explicit array of baseline tools.
const root = await harness.root(context, {
  agent: { tools: [...codingTools, ...mcp.extension.tools!] },
});
harness.resume();
```

- Restore executable tool registrations **before** resuming pending work.
- Use explicit tool arrays for every new ownerless conversation. The registry is
  process-wide; native tools become selected only after that conversation activates
  them. Tools also reject calls without matching conversation-local activation.
- Call `mcp.close()` after closing the harness to release sockets and child processes.
- Create one adapter per workspace. Calls refuse a changed working directory;
  configuration and credential identity remain bound to the original directory.

## Trust and recovery

Project MCP configuration is ignored by default. Set `trustProject: true` only
after the host obtains consent to load that project's executables and secret
commands. Ordinary Pi's saved trust decision is not inferred by this adapter.

`mcp_tools` keeps the query, activation, read, and completion contracts. Queries
never activate tools or read resource bodies. Activation stores schemas and tool
selection atomically in conversation documents. Forks inherit activation as of
the fork point. Changed or removed server definitions must be rediscovered.
Every call checks the live tool schema before invocation.

Native calls and loader operations are unsafe to replay: an interrupted external
operation becomes an error result rather than running twice. Verify its outcome
before asking the agent to retry. The adapter is not an exactly-once side-effect
system, and cancelling a call does not undo the server's effects.

## Host-owned UI

The host may supply an `ElicitationUI` as `ui` to present server requests for input.
Without it, the adapter advertises no elicitation support. Never let the model
answer user dialogs or open authentication links on its own.

Sign in with `/mcp login` in normal Pi before using OAuth servers; the adapter
shares that credential store and automatic refresh. Command handling, login UI,
prompt preview, resource watches, configuration editing, and custom renderers are
not installed. The returned `runtime` lets a host implement explicit user commands.
Prompt discovery returns metadata only; fetching or accepting a prompt remains a
user-controlled host operation. Durable results are bounded model-facing content
and JSON details, not the normal extension's codemode result protocol.
