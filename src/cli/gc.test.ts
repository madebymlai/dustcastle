import { describe, expect, it } from "vitest";
import type { NixResult } from "../store/gc.js";
import { runGcCommand } from "./gc.js";

// `dustcastle gc` (ADR 0007): the manual, user-invoked sweep — optimise then
// collect-garbage, surfacing what it freed (never silent). No threshold: the user
// asked, so it always sweeps; active runs stay protected by their live scoped roots.
// The nix runner is injected so the command is unit-tested without a real store.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });

describe("runGcCommand (manual `dustcastle gc` — ADR 0007)", () => {
  it("optimises then collects, surfaces what was freed, and exits 0", async () => {
    const lines: string[] = [];
    const run = (args: readonly string[]): NixResult => {
      if (args.includes("--optimise")) return OK("", "200 bytes (0.00 MiB) freed by hard-linking 5 files;\n");
      return OK('deleting "/nix/store/old-a"\ndeleting "/nix/store/old-b"\n8825586 bytes freed (8.42 MiB)\n');
    };

    const code = await runGcCommand({ run, onLine: (l) => lines.push(l) });

    expect(code).toBe(0);
    const summary = lines.join("\n");
    expect(summary).toContain("2"); // paths deleted
    expect(summary).toContain("8825586"); // bytes freed by the collect
    expect(summary).toContain("5"); // files hard-linked by optimise
  });
});
