import type { SelectIo } from "./terminal.js";

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_ENTER = "\r";
const KEY_CTRL_C = "\x03";
const CLEAR_LINE = "\x1b[2K";

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
      const linePrefix = firstPaint ? "" : CLEAR_LINE;
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

    const moveCursor = (nextCursor: number): void => {
      cursor = nextCursor;
      clampScroll();
      draw(false);
    };

    let dispose = (): void => undefined;
    dispose = io.onKey((key) => {
      switch (key) {
        case KEY_UP:
          moveCursor((cursor - 1 + options.length) % options.length);
          return;
        case KEY_DOWN:
          moveCursor((cursor + 1) % options.length);
          return;
        case KEY_ENTER:
          dispose();
          io.write("\n");
          done(options[cursor]!.value);
          return;
        case KEY_CTRL_C:
          dispose();
          done(undefined);
          return;
      }
    });
  });
}
