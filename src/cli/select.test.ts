import { describe, expect, it } from "vitest";
import { singleSelect, type SelectOption } from "./select.js";
import { InMemoryTerminal } from "./terminal.js";

const OPTIONS: SelectOption[] = [
  { label: "One", value: "one" },
  { label: "Two", value: "two" },
  { label: "Three", value: "three" },
  { label: "Four", value: "four" },
];

describe("singleSelect", () => {
  it("maps arrow keys plus Enter to the selected value", async () => {
    const term = new InMemoryTerminal({ rows: 10 });
    const selected = singleSelect("Pick", OPTIONS, term);

    term.feed("\x1b[B");
    term.feed("\r");

    await expect(selected).resolves.toBe("two");
  });

  it("wraps arrow navigation at the list edges", async () => {
    const term = new InMemoryTerminal({ rows: 10 });
    const selected = singleSelect("Pick", OPTIONS, term);

    term.feed("\x1b[A");
    term.feed("\r");

    await expect(selected).resolves.toBe("four");
  });

  it("renders scroll hints on short terminals", async () => {
    const term = new InMemoryTerminal({ rows: 6 });
    const selected = singleSelect("Pick", OPTIONS, term);

    term.feed("\x1b[B");
    term.feed("\x1b[B");
    term.feed("\r");

    await expect(selected).resolves.toBe("three");
    expect(term.output).toContain("  ↓ 2 more");
    expect(term.output).toContain("  ↑ 1 more");
    expect(term.output).toContain("  ↓ 1 more");
  });

  it("resolves undefined on Ctrl-C instead of exiting", async () => {
    const term = new InMemoryTerminal({ rows: 10 });
    const selected = singleSelect("Pick", OPTIONS, term);

    term.feed("\x03");

    await expect(selected).resolves.toBeUndefined();
  });

  it("keeps the picker output bytes pinned to the agentstack-port rendering", async () => {
    const term = new InMemoryTerminal({ rows: 6 });
    const selected = singleSelect("Pick", OPTIONS, term);

    term.feed("\x1b[B");
    term.feed("\x1b[B");
    term.feed("\r");

    await expect(selected).resolves.toBe("three");
    expect(term.output).toBe(
      "\nPick\n\n" +
        "\n" +
        "> One\n" +
        "  Two\n" +
        "  ↓ 2 more\n" +
        "\x1b[4A" +
        "\x1b[2K\n" +
        "\x1b[2K  One\n" +
        "\x1b[2K> Two\n" +
        "\x1b[2K  ↓ 2 more\n" +
        "\x1b[4A" +
        "\x1b[2K  ↑ 1 more\n" +
        "\x1b[2K  Two\n" +
        "\x1b[2K> Three\n" +
        "\x1b[2K  ↓ 1 more\n" +
        "\n",
    );
  });
});
