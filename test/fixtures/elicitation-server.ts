import { McpServer, UrlElicitationRequiredError, acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const server = new McpServer({ name: "elicitation-fixture", version: "1" });
server.registerTool("greet", { description: "Greet the user by name", inputSchema: z.object({}) }, async (_args, ctx) => {
  const answer = acceptedContent<{ name: string }>(ctx.mcpReq.inputResponses, "who");
  if (answer) return { content: [{ type: "text", text: `hello ${answer.name}` }] };
  return inputRequired({ inputRequests: { who: inputRequired.elicit({
    message: "Who are you?",
    requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] },
  }) } });
});
server.registerTool("connect", { description: "Require a browser step", inputSchema: z.object({}) }, async () => {
  throw new UrlElicitationRequiredError([{ mode: "url", elicitationId: "grant", message: "Authorize access", url: "https://example.com/connect" }]);
});
await server.connect(new StdioServerTransport());
