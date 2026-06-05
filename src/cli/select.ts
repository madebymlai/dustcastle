import type { SelectIo } from "./terminal.js";

/**
 * A minimal single-select TUI (arrow keys + enter), ported from agentstack's
 * `tui.mjs` so dustcastle's model picker reads identically. Renders to stderr-free
 * stdout with ANSI cursor moves; scrolls when the list exceeds the terminal
 * height. Resolves to the chosen option's `value`; Ctrl-C resolves to `undefined`
 * so callers decide how to abort.
 */
export interface SelectOption {
  readonly label: string;
  readonly value: string;
}

export function singleSelect(
  prompt: string,
  options: readonly SelectOption[],
  io: SelectIo,
): Promise<string | undefined> {
  return new Promise((done) => {
    let cursor = 0;
    let scrollOffset = 0;
    const maxVisible = Math.min(options.length, io.rows - 4);
    const needsScroll = options.length > maxVisible;
    const renderedLines = maxVisible + (needsScroll ? 2 : 0);

    const clampScroll = (): void => {
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;
    };

    const draw = (firstPaint: boolean): void => {
      const linePrefix = firstPaint ? "" : "\x1b[2K";
      if (firstPaint) {
        io.write(`\n${prompt}\n\n`);
      } else {
        io.write(`\x1b[${renderedLines}A`);
      }
      if (needsScroll) {
        const upHint = scrollOffset > 0 ? `  ↑ ${scrollOffset} more` : "";
        io.write(`${linePrefix}${upHint}\n`);
      }
      for (let i = scrollOffset; i < scrollOffset + maxVisible; i++) {
        const arrow = i === cursor ? ">" : " ";
        io.write(`${linePrefix}${arrow} ${options[i]!.label}\n`);
      }
      if (needsScroll) {
        const below = options.length - scrollOffset - maxVisible;
        io.write(`${linePrefix}${below > 0 ? `  ↓ ${below} more` : ""}\n`);
      }
    };

    clampScroll();
    draw(true);

    let dispose = (): void => undefined;
    dispose = io.onKey((key) => {
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + options.length) % options.length;
        clampScroll();
        draw(false);
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % options.length;
        clampScroll();
        draw(false);
      } else if (key === "\r") {
        dispose();
        io.write("\n");
        done(options[cursor]!.value);
      } else if (key === "\x03") {
        dispose();
        done(undefined);
      }
    });
  });
}
