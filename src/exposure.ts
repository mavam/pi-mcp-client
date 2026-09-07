import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { object } from "./config.js";
import { prepareTool, type CatalogTool } from "./catalog.js";

export const SEARCH_TOOL = "mcp_search";

/** Only successful loader results on the current branch contribute exposure. */
export function restoredTools(entries: SessionEntry[]): CatalogTool[] {
  const tools = new Map<string, CatalogTool>();
  for (const entry of entries) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      entry.message.toolName !== SEARCH_TOOL ||
      entry.message.isError
    )
      continue;
    const details: unknown = entry.message.details;
    if (!object(details) || details.mcpClient !== 1 || !Array.isArray(details.loaded))
      continue;
    for (const raw of details.loaded.slice(0, 10)) {
      if (
        !object(raw) ||
        typeof raw.server !== "string" ||
        typeof raw.identity !== "string" ||
        typeof raw.name !== "string" ||
        typeof raw.description !== "string" ||
        !object(raw.inputSchema)
      )
        continue;
      try {
        const tool = prepareTool(raw.server, raw.identity, {
          name: raw.name,
          description: raw.description,
          inputSchema: raw.inputSchema as CatalogTool["inputSchema"],
        });
        tools.set(tool.nativeName, tool);
      } catch {
        /* Old or unsupported definitions must be rediscovered. */
      }
    }
  }
  return [...tools.values()];
}

export class Exposure {
  readonly definitions = new Map<string, CatalogTool>();
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly register: (tool: CatalogTool) => void,
  ) {}

  load(tools: CatalogTool[]): {
    loaded: CatalogTool[];
    added: string[];
    rejected: string[];
  } {
    // No awaits in this mutation window: parallel searches union against live state.
    const before = this.pi.getActiveTools();
    const all = new Set(this.pi.getAllTools().map((tool) => tool.name));
    const loaded: CatalogTool[] = [];
    const rejected: string[] = [];
    for (const tool of tools) {
      if (all.has(tool.nativeName) && !this.definitions.has(tool.nativeName)) {
        rejected.push(tool.nativeName);
        continue;
      }
      const old = this.definitions.get(tool.nativeName);
      if (!old || JSON.stringify(old) !== JSON.stringify(tool)) {
        this.register(tool);
        this.definitions.set(tool.nativeName, tool);
      }
      loaded.push(tool);
    }
    this.pi.setActiveTools([
      ...new Set([...before, ...loaded.map((tool) => tool.nativeName)]),
    ]);
    // Pi applies its CLI allowlist/exclusions. Never claim a filtered tool is loaded.
    const active = new Set(this.pi.getActiveTools());
    return {
      loaded: loaded.filter((tool) => active.has(tool.nativeName)),
      added: loaded
        .filter(
          (tool) => active.has(tool.nativeName) && !before.includes(tool.nativeName),
        )
        .map((tool) => tool.nativeName),
      rejected: [
        ...rejected,
        ...loaded
          .filter((tool) => !active.has(tool.nativeName))
          .map((tool) => tool.nativeName),
      ],
    };
  }

  restore(tools: CatalogTool[]): void {
    const unrelated = this.pi
      .getActiveTools()
      .filter((name) => !this.definitions.has(name));
    this.pi.setActiveTools(unrelated);
    this.load(tools);
  }
}
