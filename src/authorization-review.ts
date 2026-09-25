import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { chooseOption } from "./prompt-selector.js";

export async function reviewAuthorization(
  ctx: ExtensionContext, server: string, requested: string[], combined: string[], signal: AbortSignal,
): Promise<boolean> {
  const text = `Server-requested scopes (untrusted data):\n${requested.join("\n")}\n\nLogin scopes (configured + granted + requested):\n${combined.join("\n")}\n\nApproval opens sign-in. The rejected operation is never replayed.`;
  if (signal.aborted) return false;
  if (ctx.mode !== "tui") {
    const lines = new Text(text, 0, 0).render(70);
    let page = 0;
    const pages = Math.ceil(lines.length / 8);
    while (!signal.aborted) {
      const choice = await chooseOption(ctx, `Permissions for ${server} · ${page + 1}/${pages}\n${lines.slice(page * 8, page * 8 + 8).join("\n")}`,
        ["Cancel", ...(page + 1 < pages ? ["Next page"] : ["Approve sign-in"]), ...(page ? ["Previous page"] : [])], signal);
      if (choice === "Next page") page++;
      else if (choice === "Previous page") page--;
      else return choice === "Approve sign-in" && !signal.aborted;
    }
    return false;
  }
  return ctx.ui.custom<boolean>((tui, theme, keys, done) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      done(approved);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    const component = authorizationReview(server, text, () => tui.terminal.rows, theme, keys, finish, () => tui.requestRender());
    return { ...component, dispose: () => signal.removeEventListener("abort", abort) };
  });
}

/** Height-bounded plain-text review. Enter advances; only explicit 'a' on the
 * last page approves. Resize reflows the body and resets review to its start.
 */
export function authorizationReview(
  server: string, text: string, rows: () => number, theme: Theme, keys: KeybindingsManager,
  done: (approved: boolean) => void, render: () => void,
): Component {
  let offset = 0, size = 1, width = 0, height = 0;
  let lines: string[] = [], last = false;
  return {
    render(columns) {
      if (columns < 24 || rows() < 14) {
        last = false;
        return [truncateToWidth("Enlarge terminal; Esc cancels", columns)];
      }
      const available = Math.max(1, rows() - 8);
      if (columns !== width || available !== height) {
        width = columns; height = available; offset = 0;
        lines = new Text(text, 0, 0).render(Math.max(1, columns));
      }
      size = Math.max(1, available - 4);
      last = offset + size >= lines.length;
      return [
        truncateToWidth(theme.fg("accent", `Permissions: ${server}`), columns),
        ...lines.slice(offset, offset + size),
        truncateToWidth(`${offset + 1}–${Math.min(offset + size, lines.length)}/${lines.length}`, columns),
        truncateToWidth(last ? "a: approve · Esc: cancel" : "Enter/↓: next · Esc: cancel", columns),
        truncateToWidth("↑: previous", columns),
      ];
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.cancel")) done(false);
      else if (data === "a" && last) done(true);
      else if (keys.matches(data, "tui.select.up")) offset = Math.max(0, offset - size);
      else if (!last && (keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.down"))) offset += size;
      render();
    },
    invalidate() {},
  };
}
