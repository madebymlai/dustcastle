import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addRootArgs,
  collectGarbage,
  collectGarbageArgs,
  garbageCollectionPlan,
  gcQueryArgs,
  gcRootLink,
  optimiseArgs,
  parseGcReport,
  parseOptimiseReport,
  pruneRecencyRoots,
  registerRecencyRoot,
  registerScopedRoots,
  recencyTailKeys,
  rootStorePaths,
  type NixResult,
} from "./gc.js";

// Store lifecycle (ADR 0007). The shared rootless /nix/store grows unbounded; 3b
// keeps it lean WITHOUT collecting paths a live run still needs: scoped GC roots
// (per-run, released on completion) pin the toolchain + deps closure, then a
// policy-driven optimise + collect-garbage frees the rest. The pure decisions
// (which paths root, command construction, report parsing) are unit-tested here;
// the live `nix-store --gc` is gated against a scratch store root.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });

describe("rootStorePaths (which paths a provision pins — ADR 0007)", () => {
  it("roots the toolchain + deps closure, skipping empties and deduping", () => {
    expect(
      rootStorePaths({ toolchainStorePath: "/nix/store/aaa-node", depsStorePath: "/nix/store/bbb-deps" }),
    ).toEqual([
      { kind: "toolchain", path: "/nix/store/aaa-node" },
      { kind: "deps", path: "/nix/store/bbb-deps" },
    ]);
  });

  it("omits the deps root on the impure path (deps install in the container, not the Store)", () => {
    expect(rootStorePaths({ toolchainStorePath: "/nix/store/aaa-node", depsStorePath: "" })).toEqual([
      { kind: "toolchain", path: "/nix/store/aaa-node" },
    ]);
  });
});

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

  it("keys the scoped-root link by project + kind (lockfile-hash scoped — ADR 0007)", () => {
    const link = gcRootLink("/roots", "sha256-AbC/d+e=", "deps");
    expect(link.startsWith("/roots/")).toBe(true);
    expect(link.endsWith("-deps")).toBe(true);
    // The link name is filesystem-safe (no slashes from the hash leak through).
    expect(link.slice("/roots/".length)).not.toContain("/");
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

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("registerScopedRoots (per-run roots, released on completion — ADR 0007)", () => {
  it("adds a root per closure path and releases them by removing the link symlinks", () => {
    const gcrootsDir = mkdtempSync(join(tmpdir(), "dustcastle-gcroots-"));
    tmps.push(gcrootsDir);
    const calls: string[][] = [];
    // Faithful runner: `nix-store --add-root <link>` creates the link (as real nix does).
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      if (args[0] === "nix-store" && args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };

    const handle = registerScopedRoots({
      provisioned: { toolchainStorePath: "/nix/store/aaa-node", depsStorePath: "/nix/store/bbb-deps" },
      gcrootsDir,
      projectKey: "sha256-deadbeef=",
      run,
    });

    // One add-root per rooted path, each realising the right store path.
    const addRoots = calls.filter((c) => c[1] === "--add-root");
    expect(addRoots).toHaveLength(2);
    expect(addRoots.map((c) => c[4])).toEqual(["/nix/store/aaa-node", "/nix/store/bbb-deps"]);
    expect(handle.links).toHaveLength(2);
    expect(handle.links.every((l) => existsSync(l))).toBe(true);

    // Releasing the scoped roots removes the link symlinks (closure becomes collectable).
    handle.release();
    expect(handle.links.some((l) => existsSync(l))).toBe(false);
  });
});

describe("recencyTailKeys (the byte-budget LRU warm set — ADR 0007)", () => {
  it("keeps the newest closures that fit the byte budget, dropping the older rest", () => {
    const records = [
      { projectKey: "npm-old", lastUsedAt: 100, closureBytes: 300 },
      { projectKey: "npm-new", lastUsedAt: 300, closureBytes: 400 },
      { projectKey: "npm-mid", lastUsedAt: 200, closureBytes: 400 },
    ];
    // Budget 900: newest (400) + mid (400) = 800 fit; old (→1100) overflows → cold.
    expect(recencyTailKeys(records, 900)).toEqual(["npm-new", "npm-mid"]);
  });

  it("keeps nothing under a zero budget", () => {
    const records = [{ projectKey: "npm-a", lastUsedAt: 1, closureBytes: 10 }];
    expect(recencyTailKeys(records, 0)).toEqual([]);
  });

  it("drops a single closure larger than the whole budget (size-bounded, not count)", () => {
    const records = [
      { projectKey: "huge-new", lastUsedAt: 300, closureBytes: 5000 },
      { projectKey: "small-old", lastUsedAt: 100, closureBytes: 100 },
    ];
    // The newest is oversize so it (and every older one, by LRU) cannot be kept.
    expect(recencyTailKeys(records, 1000)).toEqual([]);
  });
});

describe("garbageCollectionPlan (the auto-trigger's pure brain, hybrid ceiling — ADR 0007)", () => {
  const records = [
    { projectKey: "npm-a", lastUsedAt: 100, closureBytes: 200 },
    { projectKey: "npm-b", lastUsedAt: 300, closureBytes: 200 },
    { projectKey: "npm-c", lastUsedAt: 200, closureBytes: 200 },
  ];

  it("over the size cap: sweep, keeping the byte-budget tail rooted", () => {
    // total 1000 → cap 100; store 200 ≥ cap → sweep (reason cap). Budget 600 fits b+c+a (600).
    expect(
      garbageCollectionPlan({ storeBytes: 200, freeBytes: 500, totalBytes: 1000, records, budgetBytes: 600 }),
    ).toEqual({ sweep: true, reason: "cap", keep: ["npm-b", "npm-c", "npm-a"] });
  });

  it("over the free-space floor: sweep (reason floor), bounding the tail by bytes", () => {
    // store 50 (< cap 100), free 50 ≤ 100 floor → sweep. Budget 450 fits b+c (400); a (→600) overflows.
    expect(
      garbageCollectionPlan({ storeBytes: 50, freeBytes: 50, totalBytes: 1000, records, budgetBytes: 450 }),
    ).toEqual({ sweep: true, reason: "floor", keep: ["npm-b", "npm-c"] });
  });

  it("under both thresholds: no sweep (the tail still stands)", () => {
    expect(
      garbageCollectionPlan({ storeBytes: 50, freeBytes: 500, totalBytes: 1000, records, budgetBytes: 600 }),
    ).toEqual({ sweep: false, reason: "none", keep: ["npm-b", "npm-c", "npm-a"] });
  });
});

describe("registerRecencyRoot / pruneRecencyRoots (the persistent warm roots — ADR 0007)", () => {
  it("registers a persistent root per closure path (not released with the run)", () => {
    const recencyRootsDir = mkdtempSync(join(tmpdir(), "dustcastle-recency-roots-"));
    tmps.push(recencyRootsDir);
    const run = (args: readonly string[]): NixResult => {
      if (args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };

    const { links } = registerRecencyRoot({
      provisioned: { toolchainStorePath: "/nix/store/aaa-node", depsStorePath: "/nix/store/bbb-deps" },
      recencyRootsDir,
      projectKey: "npm-deadbeef=",
      run,
    });

    expect(links).toHaveLength(2);
    expect(links.every((l) => existsSync(l))).toBe(true);
  });

  it("prunes the roots whose project key falls outside the warm budget, keeping the rest", () => {
    const recencyRootsDir = mkdtempSync(join(tmpdir(), "dustcastle-recency-roots-"));
    tmps.push(recencyRootsDir);
    const run = (args: readonly string[]): NixResult => {
      if (args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };
    for (const key of ["npm-warm=", "npm-cold="]) {
      registerRecencyRoot({
        provisioned: { toolchainStorePath: `/nix/store/${key}-tc`, depsStorePath: "" },
        recencyRootsDir,
        projectKey: key,
        run,
      });
    }

    const { pruned } = pruneRecencyRoots({ recencyRootsDir, keepKeys: ["npm-warm="] });

    expect(pruned).toBe(1); // only the cold root removed
    expect(existsSync(gcRootLink(recencyRootsDir, "npm-warm=", "toolchain"))).toBe(true);
    expect(existsSync(gcRootLink(recencyRootsDir, "npm-cold=", "toolchain"))).toBe(false);
  });

  it("prunes nothing when the recency-roots dir does not exist (best-effort)", () => {
    expect(pruneRecencyRoots({ recencyRootsDir: join(tmpdir(), "dustcastle-no-such-dir-xyz"), keepKeys: [] })).toEqual({
      pruned: 0,
    });
  });
});

describe("collectGarbage (the policy-driven sweep — ADR 0007)", () => {
  it("optimises then collects, returning the surfaced reports", () => {
    const calls: string[][] = [];
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      if (args.includes("--optimise")) return OK("", "100 bytes (0.00 MiB) freed by hard-linking 3 files;\n");
      return OK('deleting "/nix/store/old"\n50 bytes freed (0.00 MiB)\n');
    };

    const report = collectGarbage({ run, optimise: true });

    expect(calls.map((c) => c[1])).toEqual(["--optimise", "--gc"]); // optimise BEFORE gc
    expect(report.optimise).toEqual({ bytesFreed: 100, filesLinked: 3 });
    expect(report.gc).toEqual({ pathsDeleted: 1, bytesFreed: 50 });
  });

  it("skips optimise when not requested", () => {
    const calls: string[][] = [];
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      return OK("0 bytes freed (0.00 MiB)\n");
    };

    const report = collectGarbage({ run });

    expect(calls.map((c) => c[1])).toEqual(["--gc"]);
    expect(report.optimise).toBeUndefined();
  });
});
