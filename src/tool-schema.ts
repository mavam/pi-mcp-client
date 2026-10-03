import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./catalog.js";

export const MCP_TOOLS_PARAMETERS = Type.Object(
      {
        query: Type.Optional(Type.String({
          minLength: 1,
          maxLength: 500,
          description:
            "One focused capability, exact tool or prompt name, or resource URI. Searches catalog metadata only; never reads content or activates tools.",
        })),
        kind: Type.Optional(StringEnum(["all", "tools", "resources", "prompts"] as const, {
          description: "Candidate kinds to search: all (default), tools, resources, or prompts. Query only.",
        })),
        complete: Type.Optional(Type.Object({
          server: Type.String({ minLength: 1, maxLength: 80 }),
          template: Type.String({ minLength: 1, maxLength: 4096, description: "Exact advertised URI template." }),
          argument: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 512 }),
            value: Type.String({ maxLength: 4096, description: "Current prefix; may be empty." }),
          }, { additionalProperties: false }),
          arguments: Type.Optional(Type.Record(Type.String({ maxLength: 512 }), Type.String({ maxLength: 4096 }), { maxProperties: 100 })),
        }, { additionalProperties: false, description: "Complete one resource template variable. Mutually exclusive with other top-level arguments." })),
        read: Type.Optional(Type.Object({
          server: Type.String({ minLength: 1, maxLength: 80, description: "Configured MCP server that owns this resource." }),
          uri: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Exact absolute resource URI. Mutually exclusive with template and arguments." })),
          template: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Exact URI template advertised by this server. Supply arguments instead of uri." })),
          arguments: Type.Optional(Type.Record(Type.String(), Type.Union([
            Type.String({ maxLength: 4096 }), Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
          ]), { maxProperties: 100, description: "SDK URI-template variables: strings or string arrays. Use known values; templates do not declare required fields. Required with template, forbidden with uri." })),
        }, { additionalProperties: false, description: "Read one resource and attach its bounded content as this tool result. Mutually exclusive with all other top-level arguments." })),
        activate: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 600 }), {
          minItems: 1,
          maxItems: MAX_SEARCH_LIMIT,
          description: "Exact server.tool or mcp__server__tool identifiers to activate, without invoking. Duplicates are ignored. Cannot be combined with query, kind, read, server, or limit.",
        })),
        server: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 80,
            description: "Restrict discovery to this configured MCP server.",
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            default: DEFAULT_SEARCH_LIMIT,
            description: `Maximum number of candidates to return: 1–${MAX_SEARCH_LIMIT} inclusive (default: ${DEFAULT_SEARCH_LIMIT}). This is not a limit on records returned by a native tool. Omit unless more candidates are needed.`,
          }),
        ),
      },
      { additionalProperties: false },
    );
