import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "stdio-fixture", version: "1" });
server.registerTool(
  "echo",
  { description: "Echo text", inputSchema: z.object({ text: z.string() }) },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);
server.registerTool(
  "fail",
  { description: "Return a tool failure", inputSchema: z.object({}) },
  async () => ({
    content: [{ type: "text", text: "Expected failure" }],
    isError: true,
  }),
);
process.stderr.write("Fixture diagnostics must not reach the terminal.\n");
await server.connect(new StdioServerTransport());
