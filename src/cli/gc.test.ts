import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import type { NixResult } from "../store/gc.js";
import { runGcCommand } from "./gc.js";

// `dustcastle gc` (ADR 0007/0012): the manual, user-invoked sweep — optimise then
// collect-garbage, surfacing what it freed (never silent). No threshold: the user
// asked, so it always sweeps; active runs stay protected by their live scoped roots.
// It drives the SAME pool brain as the auto sweep (collectPools over the Store + the
// deps cache), so a manual gc reclaims both pools. The nix runner and the pool dirs
// are injected so the command is unit-tested without a real store or the real home.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });

const tmps: string[] = [];
const mkTmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dc-gc-"));
  tmps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("runGcCommand (manual `dustcastle gc` — ADR 0007/0012)", () => {
  it("optimises then collects the Store, surfaces what was freed, and exits 0", async () => {
    const root = createMemoryLogger();
    const logger = root.child({ mod: "gc" });
    const run = (args: readonly string[]): NixResult => {
      if (args.includes("--optimise")) return OK("", "200 bytes (0.00 MiB) freed by hard-linking 5 files;\n");
      return OK('deleting "/nix/store/old-a"\ndeleting "/nix/store/old-b"\n8825586 bytes freed (8.42 MiB)\n');
    };

    const code = await runGcCommand({
      run,
      dir: mkTmp(),
      recencyRootsDir: mkTmp(),
      depsCacheDir: mkTmp(),
      logger,
    });

    expect(code).toBe(0);
    expect(root.records.some((r) => r.level === "info" && r.msg === "gc done" && r.fields.entriesEvicted === 2)).toBe(true);
    expect(root.records.some((r) => r.fields.bytesFreed === 8825586)).toBe(true);
    expect(root.records.some((r) => r.fields.filesLinked === 5)).toBe(true);
  });

  it("also evicts the deps cache (budget 0 — nothing pinned in a manual sweep)", async () => {
    const depsCacheDir = mkTmp();
    const coldEntry = join(depsCacheDir, "abc123");
    mkdirSync(coldEntry, { recursive: true });
    writeFileSync(join(coldEntry, "node_modules.bin"), "x".repeat(4096));

    const run = (args: readonly string[]): NixResult =>
      args.includes("--optimise") ? OK("", "0 bytes freed by hard-linking 0 files;\n") : OK("0 bytes freed (0.00 MiB)\n");

    const code = await runGcCommand({ run, dir: mkTmp(), recencyRootsDir: mkTmp(), depsCacheDir });

    expect(code).toBe(0);
    expect(existsSync(coldEntry)).toBe(false); // the cold cache entry was reclaimed
  });
});
