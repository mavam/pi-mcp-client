import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ConfigMutationError, inspectConfigScopes, type Config, type ConfigMutation, type ConfigScope } from "./config.js";
import { importPreview, parseImportCommand, readImportSource, validImportName, validateImportCandidate } from "./imports.js";

type Scopes = Awaited<ReturnType<typeof inspectConfigScopes>>;

export function importAction(name: string, scope: ConfigScope, scopes: Scopes): string {
  const exists = Object.hasOwn(scopes[scope], name);
  if (scope === "global" && Object.hasOwn(scopes.project, name))
    return `${exists ? "Replace" : "Add"} global definition (project stays effective)`;
  if (exists) return `Replace ${scope} definition`;
  if (scope === "project" && Object.hasOwn(scopes.global, name)) return "Override global definition";
  return `Add ${scope} definition`;
}

/** UI-only import: keep raw source values out of notifications, sessions, and model context. */
export async function runImportCommand(
  input: string,
  ctx: ExtensionCommandContext,
  agentDir: string,
  signal: AbortSignal,
  assertCurrent: () => void,
  save: (mutation: Extract<ConfigMutation, { action: "import" }>, guard: () => void) => Promise<unknown>,
): Promise<void> {
  if (!ctx.hasUI) throw new ConfigMutationError("Configuration imports require an interactive session (TUI or RPC).");
  const { scope, path } = parseImportCommand(input);
  const trusted = ctx.isProjectTrusted();
  if (scope === "project" && !trusted)
    throw new ConfigMutationError("Project configuration requires a trusted project. Use global scope or trust the project first.");
  const guard = () => {
    signal.throwIfAborted();
    assertCurrent();
    if (ctx.isProjectTrusted() !== trusted)
      throw new ConfigMutationError("Project trust changed during the preview. Run /mcp import again; nothing was saved.");
  };
  const select = async (title: string, choices: string[]) => {
    guard();
    const result = await ctx.ui.select(title, choices, { signal });
    guard();
    // RPC clients can return arbitrary strings. Treat unknown selections as cancellation.
    return result !== undefined && choices.includes(result) ? result : undefined;
  };
  guard();
  const source = await readImportSource(path, ctx.cwd, signal);
  guard();
  const scopes = await inspectConfigScopes(agentDir, ctx.cwd, trusted);
  guard();
  if (source.path === scopes.targets[scope])
    throw new ConfigMutationError("Import source and destination are the same file. Choose a different destination scope or source file.");
  if (!source.candidates.length) {
    ctx.ui.notify("No servers found in the import file. Nothing was changed.", "info");
    return;
  }
  const selected: Config = Object.create(null);
  const summary: string[] = [];
  const cancel = () => ctx.ui.notify("Import cancelled. Nothing was saved.", "info");
  if (source.ignoredTopLevel) {
    const proceed = await select(
      `Import file contains ${source.ignoredTopLevel} other top-level setting(s)\nOnly MCP server definitions are imported. Other settings, permissions, and credential stores are not imported.`,
      ["Continue", "Cancel import"],
    );
    if (proceed !== "Continue") { cancel(); return; }
  }
  let candidates = source.candidates;
  if (source.groups) {
    const group = await select("Choose Claude source group\nSource projects are not destination scopes. Review each selected definition; names are never merged automatically.",
      [...source.groups, "All groups", "Cancel import"]);
    if (group === undefined || group === "Cancel import") { cancel(); return; }
    if (group !== "All groups") candidates = candidates.filter((candidate) => candidate.group === group);
  }
  for (const [index, candidate] of candidates.entries()) {
    const problem = validateImportCandidate(candidate, ctx.cwd);
    let name = candidate.name;
    while (true) {
      const duplicate = name !== undefined && Object.hasOwn(selected, name);
      const action = name && !duplicate && !problem ? importAction(name, scope, scopes) : undefined;
      const conflict = name ? [
        Object.hasOwn(scopes.global, name) ? "global" : undefined,
        Object.hasOwn(scopes.project, name) ? "project" : undefined,
      ].filter(Boolean).join(" and ") : "";
      const choice = await select([
        `Import preview ${index + 1}/${candidates.length} · ${scope} scope · ${source.format === "codex" ? "Codex TOML" : "JSON"}`,
        importPreview(candidate, problem),
        ...(name ? [`Destination name: ${name}`] : []),
        ...(conflict ? [`Existing definition in ${conflict} scope; fields and credentials are never merged.`] : []),
        ...(duplicate ? ["This destination name is already selected; choose a different name."] : []),
      ].join("\n"), ["Skip", ...(action ? [action] : []), ...(!problem ? ["Choose a different name"] : []), "Cancel import"]);
      if (choice === undefined || choice === "Cancel import") { cancel(); return; }
      if (choice === "Skip") break;
      if (choice === "Choose a different name") {
        const value = await ctx.ui.input("Destination server name (1–80 letters, digits, underscores, or hyphens; start with a letter or digit)", "Server name", { signal });
        guard();
        if (value === undefined) continue;
        if (!validImportName(value)) {
          ctx.ui.notify("Invalid server name. The previous choice was retained.", "error");
          continue;
        }
        name = value;
        continue;
      }
      if (choice === action && name && candidate.definition) {
        selected[name] = structuredClone(candidate.definition);
        summary.push(`${name} · ${candidate.transport} · ${action}`);
        break;
      }
    }
  }
  if (!summary.length) {
    ctx.ui.notify("No servers selected. Nothing was saved.", "info");
    return;
  }
  // Review all destination actions in bounded pages before the final trust confirmation.
  const pages = Math.ceil(summary.length / 6);
  let page = 0;
  while (true) {
    const action = await select(
      `Review import ${page + 1}/${pages} · ${scope} scope\n${summary.slice(page * 6, (page + 1) * 6).join("\n")}`,
      [...(page + 1 < pages ? ["Next page"] : ["Continue to confirmation"]), ...(page > 0 ? ["Previous page"] : []), "Cancel import"],
    );
    if (action === undefined || action === "Cancel import") { cancel(); return; }
    if (action === "Next page") page++;
    else if (action === "Previous page") page--;
    else break;
  }
  const confirmed = await ctx.ui.confirm(`Import ${summary.length} server(s) into ${scope} configuration?`,
    "Only continue if you trust the source file. Connection values, including any inline credentials, are copied with the reviewed definitions. Replacements replace the whole definition.\n" +
    "No external credential store is read. Existing Pi OAuth credentials are retained.\n" +
    "Importing does not connect, execute commands, or authenticate. Enabled servers can run programs or send configured credentials when used later.",
    { signal });
  guard();
  if (confirmed !== true) { cancel(); return; }
  if (!ctx.isIdle()) throw new ConfigMutationError("The agent is busy. Run /mcp import again when it is idle; nothing was saved.");
  await save({ action: "import", scope, servers: selected, expected: scopes.expected, sourcePath: source.path }, guard);
  ctx.ui.notify(`✔︎ Imported ${summary.length} server(s) into ${scope} configuration. No connections were opened, commands executed, or credentials migrated from external stores.`, "info");
}
