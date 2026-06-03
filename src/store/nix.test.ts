import { describe, expect, it } from "vitest";
import {
  addRootArgs,
  collectGarbageArgs,
  gcQueryArgs,
  optimiseArgs,
  parseGcReport,
  parseOptimiseReport,
} from "./nix.js";

// The full nix-portable port (nix.ts): command construction + report parsing for
// the nix-store vocabulary driven through nix-portable. The pure decisions are
// unit-tested here; the live nix-store invocations are gated against a scratch
// store root. These cases moved verbatim from gc.test.ts when the nix surface was
// extracted into its own module.

describe("command construction (driven through nix-portable — ADR 0007)", () => {
  it("registers an indirect GC root with `nix-store --add-root <link> --realise <path>`", () => {
    expect(addRootArgs("/nix/store/aaa-node", "/roots/proj-toolchain")).toEqual([
      "nix-store",
      "--add-root",
      "/roots/proj-toolchain",
      "--realise",
      "/nix/store/aaa-node",
    ]);
  });

  it("builds the collect-garbage and optimise invocations", () => {
    expect(collectGarbageArgs()).toEqual(["nix-store", "--gc"]);
    expect(optimiseArgs()).toEqual(["nix-store", "--optimise"]);
  });

  it("builds non-destructive dry-run queries (paths a sweep would keep/delete)", () => {
    expect(gcQueryArgs("dead")).toEqual(["nix-store", "--gc", "--print-dead"]);
    expect(gcQueryArgs("live")).toEqual(["nix-store", "--gc", "--print-live"]);
  });
});

describe("report parsing (the surfaced, never-silent GC report — ADR 0007)", () => {
  it("parses paths-deleted + bytes-freed from `nix-store --gc` output", () => {
    const out =
      'deleting "/nix/store/xxx-old"\ndeleting "/nix/store/yyy-old"\n8825586 bytes freed (8.42 MiB)\n';
    expect(parseGcReport(out)).toEqual({ pathsDeleted: 2, bytesFreed: 8825586 });
  });

  it("parses bytes-freed + files-linked from `nix-store --optimise` output", () => {
    const out = "541838819 bytes (516.74 MiB) freed by hard-linking 54143 files;\n";
    expect(parseOptimiseReport(out)).toEqual({ bytesFreed: 541838819, filesLinked: 54143 });
  });

  it("reports nothing freed when the store is already lean", () => {
    expect(parseGcReport("0 bytes freed (0.00 MiB)\n")).toEqual({ pathsDeleted: 0, bytesFreed: 0 });
  });
});
