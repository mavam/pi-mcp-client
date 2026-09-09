import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { line } from "./catalog.js";
import { commandWords } from "./config-commands.js";
import { failure } from "./diagnostics.js";
import { preparePromptSnapshot, validPromptArguments, type CatalogPrompt, type PromptSnapshot } from "./prompts.js";
import type { McpRuntime } from "./runtime.js";
import { promptSelector } from "./prompt-selector.js";

export class PromptCommandError extends Error {}
export const PROMPT_USAGE = "Use /mcp prompt <server> [name] [argument=value ...].";

export function parsePromptCommand(input: string): { server: string; name: string | undefined; args: Record<string, string> } {
  const [action, server, name, ...words] = commandWords(input);
  if (action !== "prompt" || !server) throw new PromptCommandError(PROMPT_USAGE);
  const args: Record<string, string> = Object.create(null);
  for (const word of words) {
    const equals = word.indexOf("=");
    const key = word.slice(0, equals);
    if (equals <= 0 || Object.hasOwn(args, key)) throw new PromptCommandError(PROMPT_USAGE);
    args[key] = word.slice(equals + 1);
  }
  return { server, name, args };
}

export async function runPromptCommand(
  input: string, ctx: ExtensionCommandContext, runtime: McpRuntime,
  signal: AbortSignal, assertCurrent: () => void,
  use: (prompt: CatalogPrompt, snapshot: PromptSnapshot) => void,
): Promise<void> {
  if (!ctx.hasUI) throw new PromptCommandError("Prompt selection requires an interactive session.");
  const { server, name, args } = parsePromptCommand(input);
  const guard = () => { signal.throwIfAborted(); assertCurrent(); };
  const select = async (title: string, choices: string[]) => {
    guard();
    const selected = ctx.mode !== "tui"
      ? await ctx.ui.select(title, choices, { signal })
      : await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
        let settled = false;
        const finish = (choice: string | undefined) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          done(choice);
        };
        const abort = () => finish(undefined);
        signal.addEventListener("abort", abort, { once: true });
        const selector = promptSelector(title, choices, theme, keys, finish, () => tui.requestRender());
        return { ...selector, dispose: () => signal.removeEventListener("abort", abort) };
      });
    guard();
    return selected;
  };
  const request = async <T>(title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    guard();
    if (ctx.mode !== "tui") {
      const result = await work(signal);
      guard();
      return result;
    }
    const outcome = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, title);
      const combined = AbortSignal.any([signal, loader.signal]);
      let settled = false;
      const finish = (outcome: { value: T } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        done(outcome);
      };
      loader.onAbort = () => finish({ error: failure("cancelled", { server, operation: "prompt" }) });
      work(combined).then((value) => finish({ value }), (error) => finish({ error }));
      return loader;
    });
    guard();
    if (!outcome) throw failure("cancelled", { server, operation: "prompt" });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  };

  const prompts = await request(`${server} · Fetching prompt metadata…`, (signal) => runtime.promptCatalog(server, signal));
  if (!prompts.length) {
    ctx.ui.notify(`${server}: no prompts available.`, "info");
    return;
  }
  let prompt = name ? prompts.find((prompt) => prompt.name === name) : undefined;
  if (name && !prompt) throw failure("prompt_not_found", { server, operation: "prompt" });
  if (!prompt) {
    const sorted = [...prompts].sort((a, b) => a.name.localeCompare(b.name));
    const width = ctx.mode === "tui" ? process.stdout.columns || 80 : 80;
    const labels = sorted.map((prompt, index) => truncateToWidth(`${index + 1}. ${line(prompt.name)} — ${line(prompt.description)}`, Math.max(1, width - 4)));
    const selected = await select(`${server} · Prompts (metadata only; select to enter arguments)`, labels);
    if (selected === undefined) return;
    prompt = sorted[labels.indexOf(selected)];
    if (!prompt) return;
  }
  if (Object.entries(args).some(([key, value]) => !prompt!.arguments.some((arg) => arg.name === key) || value.length > 4096))
    throw failure("prompt_invalid", { server, operation: "prompt" });

  while (true) {
    const labels = prompt.arguments.map((arg, index) => `${index + 1}. ${line(arg.name)} (${arg.required ? "required" : "optional"}) · ${Object.hasOwn(args, arg.name) ? JSON.stringify(line(args[arg.name]).slice(0, 60)) : "not supplied"}`);
    const action = await select(`${server} · ${line(prompt.name)}\n${line(prompt.description).slice(0, 240)}\nArguments are sent to this server only when you fetch a preview.\nYour conversation and local files aren't automatically shared.`, [...labels, "Fetch preview", "Cancel"]);
    if (action === undefined || action === "Cancel") return;
    const argument = prompt.arguments[labels.indexOf(action)];
    if (argument) {
      const choice = await select(`${line(argument.name)}\n${line(argument.description).slice(0, 400)}`, ["Edit value", ...(!argument.required ? ["Omit argument"] : []), "Back"]);
      if (choice === "Omit argument") delete args[argument.name];
      else if (choice === "Edit value") {
        const value = await ctx.ui.editor(`${line(argument.name)} · string, at most 4096 characters`, args[argument.name] ?? "");
        guard();
        if (value !== undefined) {
          if (value.length > 4096) ctx.ui.notify("Argument exceeds 4096 characters. The previous value was retained.", "error");
          else args[argument.name] = value;
        }
      }
      continue;
    }
    if (action !== "Fetch preview") continue;
    if (!validPromptArguments(prompt, args)) {
      ctx.ui.notify("Supply every required argument and keep total argument data within 64 KiB.", "error");
      continue;
    }
    // This is the only content fetch. Back deliberately discards the snapshot.
    const result = await request(`${server} · Fetching prompt preview…`, (signal) => runtime.getPrompt(server, prompt!.name, args, signal));
    const snapshot = preparePromptSnapshot(result, server);
    // Wrap and paginate the complete normalized snapshot. Native dialogs work in TUI and RPC.
    const width = ctx.mode === "tui" ? process.stdout.columns || 80 : 80;
    const lines = new Text(snapshot.preview, 0, 0).render(Math.max(1, width - 6));
    const pageSize = Math.max(1, Math.min(16, (ctx.mode === "tui" ? process.stdout.rows || 30 : 30) - 14));
    let page = 0;
    while (true) {
      const total = Math.ceil(lines.length / pageSize);
      const preview = await select(`${server} · ${line(prompt.name)} · Preview ${page + 1}/${total}\nServer-provided content — review before using.\n${lines.slice(page * pageSize, (page + 1) * pageSize).join("\n")}\n${snapshot.usable ? "Use prompt sends this snapshot to the model and saves it in the session." : "Unsupported content: this prompt cannot be used. Nothing will be omitted silently."}`, [
        ...(page + 1 < total ? ["Next page"] : []), ...(page > 0 ? ["Previous page"] : []),
        ...(snapshot.usable ? ["Use prompt"] : []), "Back", "Cancel",
      ]);
      if (preview === undefined || preview === "Cancel") return;
      if (preview === "Back") break;
      if (preview === "Next page") page++;
      if (preview === "Previous page") page--;
      if (preview === "Use prompt" && snapshot.usable) {
        guard();
        if (!ctx.isIdle()) throw new PromptCommandError("The agent is busy. Select the prompt again when it is idle.");
        use(prompt, snapshot);
        return;
      }
    }
  }
}
