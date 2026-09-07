import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import extension from "../src/index.js";

// A real Pi loop and real MCP HTTP transport; the model endpoint is local and
// deterministic, so this test never consumes API credentials or model quota.
for (const provider of ["anthropic", "openai"] as const)
  test(`Pi ${provider}: search loads a deferred native tool for the next turn`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mcp-integration-"));
    let called = 0;
    const mcp = createMcpHandler(() => {
      const server = new McpServer({ name: "fixture", version: "1" });
      server.registerTool(
        "echo",
        {
          description: "Echo a message",
          inputSchema: z.object({ message: z.string() }),
        },
        async ({ message }) => {
          called++;
          return { content: [{ type: "text", text: `echo: ${message}` }] };
        },
      );
      return server;
    });
    const requests: Record<string, any>[] = [];
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/mcp") return mcp.fetch(req);
        requests.push((await req.json()) as Record<string, any>);
        const turn = requests.length;
        if (provider === "openai") {
          const item =
            turn <= 2
              ? {
                  type: "function_call",
                  id: `fc_${turn}`,
                  call_id: `call_${turn}`,
                  name: turn === 1 ? "mcp_search" : "mcp__fixture__echo",
                  arguments: JSON.stringify(
                    turn === 1 ? { query: "echo" } : { message: "hello" },
                  ),
                  status: "completed",
                }
              : {
                  type: "message",
                  id: `msg_${turn}`,
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "Done", annotations: [] }],
                };
          const events = [
            {
              type: "response.created",
              response: { id: `resp_${turn}`, status: "in_progress", output: [] },
            },
            { type: "response.output_item.added", output_index: 0, item },
            { type: "response.output_item.done", output_index: 0, item },
            {
              type: "response.completed",
              response: {
                id: `resp_${turn}`,
                status: "completed",
                output: [item],
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              },
            },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        const events: Record<string, unknown>[] = [
          {
            type: "message_start",
            message: {
              id: `msg_${turn}`,
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
        ];
        if (turn <= 2) {
          events.push({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: `call_${turn}`,
              name: turn === 1 ? "mcp_search" : "mcp__fixture__echo",
              input: {},
            },
          });
          events.push({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(
                turn === 1 ? { query: "echo" } : { message: "hello" },
              ),
            },
          });
        } else {
          events.push({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          events.push({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Done" },
          });
        }
        events.push(
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: turn <= 2 ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 10 },
          },
          { type: "message_stop" },
        );
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await writeFile(
        join(directory, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: {
              type: "http",
              url: `http://127.0.0.1:${http.port}/mcp`,
              description: "Echo test messages",
            },
          },
        }),
      );
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: join(directory, "models.json"),
        modelsStorePath: join(directory, "models-store.json"),
        allowModelNetwork: false,
      });
      modelRuntime.registerProvider(provider, {
        baseUrl: `http://127.0.0.1:${http.port}`,
        apiKey: "local-test-key",
      });
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [(pi) => extension(pi, { agentDir: directory })],
      });
      await loader.reload();
      const created = await createAgentSession({
        cwd: directory,
        agentDir: directory,
        resourceLoader: loader,
        modelRuntime,
        model: modelRuntime.getModel(
          provider,
          provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.4",
        )!,
        sessionManager: SessionManager.inMemory(directory),
        settingsManager,
        noTools: "builtin",
      });
      session = created.session;
      await session.bindExtensions({ mode: "print" });
      await session.prompt("Echo hello with MCP");
      expect(requests).toHaveLength(3);
      expect(requests[0].tools.map((tool: any) => tool.name)).toEqual(["mcp_search"]);
      expect(JSON.stringify(requests[1])).toContain("mcp__fixture__echo");
      const loaderResult = session.messages.find(
        (message) => message.role === "toolResult" && message.toolName === "mcp_search",
      );
      expect(
        loaderResult?.role === "toolResult" && loaderResult.addedToolNames,
      ).toEqual(["mcp__fixture__echo"]);
      if (provider === "anthropic") {
        expect(JSON.stringify(requests[1].messages)).toContain("tool_reference");
        expect(JSON.stringify(requests[1].system)).toBe(
          JSON.stringify(requests[0].system),
        );
      } else {
        // Pi 0.85.1 anchors native definitions with additional_tools on Responses.
        expect(
          requests[1].input.some((item: any) => item.type === "additional_tools"),
        ).toBe(true);
        expect(requests[1].input[0]).toEqual(requests[0].input[0]);
        expect(requests[1].tools).toEqual(requests[0].tools);
      }
      expect(called).toBe(1);
      const callResult = session.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "mcp__fixture__echo",
      );
      expect(callResult?.role === "toolResult" && callResult.isError).toBe(false);
      expect(JSON.stringify(callResult)).toContain("echo: hello");
      const end = session.sessionManager.getLeafId()!;
      const start = session.sessionManager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "user")!;
      await session.navigateTree(start.id, { summarize: false });
      expect(session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
      await session.navigateTree(end, { summarize: false });
      expect(session.getActiveToolNames()).toContain("mcp__fixture__echo");
    } finally {
      if (session) {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      await mcp.close();
      await http.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
