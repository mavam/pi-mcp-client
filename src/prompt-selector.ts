import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, type Component } from "@earendil-works/pi-tui";

/** Native selectors in RPC; a TUI selector with a plain-text body. Aborting closes it. */
export async function chooseOption(
  ctx: ExtensionContext, title: string, choices: string[], signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return;
  if (ctx.mode !== "tui") return ctx.ui.select(title, choices, { signal });
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
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
}

/** Keep explanatory text outside the accent/bold heading used by native selectors. */
export function promptSelector(
  title: string, choices: string[], theme: Theme, keys: KeybindingsManager,
  done: (choice: string | undefined) => void, render: () => void,
): Component {
  const [heading, ...body] = title.split("\n");
  const list = new SelectList(choices.map((value) => ({ value, label: value })), 8, {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("muted", text),
  });
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
  return {
    render(width) {
      const hint = `${keys.getKeys("tui.select.up").join("/")}/${keys.getKeys("tui.select.down").join("/")} navigate · ${keys.getKeys("tui.select.confirm").join("/")} select · ${keys.getKeys("tui.select.cancel").join("/")} cancel`;
      return [
        ...new Text(theme.fg("accent", theme.bold(heading)), 0, 0).render(width),
        ...(body.length ? ["", ...new Text(theme.fg("text", body.join("\n")), 0, 0).render(width)] : []),
        "", ...list.render(width), "",
        ...new Text(theme.fg("dim", hint), 0, 0).render(width),
      ];
    },
    handleInput(data) {
      const index = choices.indexOf(list.getSelectedItem()?.value ?? "");
      if (keys.matches(data, "tui.select.cancel")) done(undefined);
      else if (keys.matches(data, "tui.select.confirm")) done(list.getSelectedItem()?.value);
      else if (keys.matches(data, "tui.select.up") || data === "k") list.setSelectedIndex(Math.max(0, index - 1));
      else if (keys.matches(data, "tui.select.down") || data === "j") list.setSelectedIndex(Math.min(choices.length - 1, index + 1));
      render();
    },
    invalidate() { list.invalidate(); },
  };
}
