/**
 * A minimal single-select TUI (arrow keys + enter), ported from agentstack's
 * `tui.mjs` so dustcastle's model picker reads identically. Renders to stderr-free
 * stdout with ANSI cursor moves; scrolls when the list exceeds the terminal
 * height. Resolves to the chosen option's `value`. Ctrl-C exits the process.
 */
export interface SelectOption {
  readonly label: string;
  readonly value: string;
}

export function singleSelect(prompt: string, options: SelectOption[]): Promise<string> {
  return new Promise((done) => {
    let cursor = 0;
    let scrollOffset = 0;
    const maxVisible = Math.min(options.length, (process.stdout.rows || 24) - 4);
    const needsScroll = options.length > maxVisible;
    const renderedLines = maxVisible + (needsScroll ? 2 : 0);

    const clampScroll = (): void => {
      if (cursor < scrollOffset) scrollOffset = cursor;
      if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;
    };

    const render = (): void => {
      process.stdout.write(`\x1b[${renderedLines}A`);
      if (needsScroll) {
        const upHint = scrollOffset > 0 ? `  ↑ ${scrollOffset} more` : "";
        process.stdout.write(`\x1b[2K${upHint}\n`);
      }
      for (let i = scrollOffset; i < scrollOffset + maxVisible; i++) {
        const arrow = i === cursor ? ">" : " ";
        process.stdout.write(`\x1b[2K${arrow} ${options[i]!.label}\n`);
      }
      if (needsScroll) {
        const below = options.length - scrollOffset - maxVisible;
        process.stdout.write(`\x1b[2K${below > 0 ? `  ↓ ${below} more` : ""}\n`);
      }
    };

    console.log(`\n${prompt}\n`);
    clampScroll();
    if (needsScroll) console.log("");
    for (let i = scrollOffset; i < scrollOffset + maxVisible; i++) {
      const arrow = i === cursor ? ">" : " ";
      console.log(`${arrow} ${options[i]!.label}`);
    }
    if (needsScroll) {
      const below = options.length - scrollOffset - maxVisible;
      console.log(below > 0 ? `  ↓ ${below} more` : "");
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onKey = (key: string): void => {
      if (key === "\x1b[A") {
        cursor = (cursor - 1 + options.length) % options.length;
        clampScroll();
        render();
      } else if (key === "\x1b[B") {
        cursor = (cursor + 1) % options.length;
        clampScroll();
        render();
      } else if (key === "\r") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onKey);
        console.log("");
        done(options[cursor]!.value);
      } else if (key === "\x03") {
        process.exit(0);
      }
    };

    process.stdin.on("data", onKey);
  });
}
