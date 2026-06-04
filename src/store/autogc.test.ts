import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { autoGc, readLastSweepLine } from "./autogc.js";
import { gcRootLink } from "./gcRoots.js";
import type { NixResult } from "./nix.js";
import { upsertRecency } from "./recency.js";

// The detached one-shot's brain (ADR 0007): lock → measure → load recency → plan →
// optimise-first → re-check → conditional gc → prune the cold recency roots → log.
// Fully injected (nix runner, store-size measure, disk statfs, clock), so the whole
// command sequence is unit-tested and the real `nix-store --gc` stays gated. Every
// failure is best-effort: it surfaces a warn record and never throws out of a run.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });
const OPTIMISE_OUT = "100 bytes (0.00 MiB) freed by hard-linking 5 files;\n";
const GC_OUT = 'deleting "/nix/store/x-old"\ndeleting "/nix/store/y-old"\n4200 bytes freed (0.00 MiB)\n';

const dirs: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-autogc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A disk fake that yields the queued free/total readings in order (statfs stand-in). */
function diskSeq(readings: Array<{ free: number; total: number }>): () => { free: number; total: number } {
  let i = 0;
  return () => readings[Math.min(i++, readings.length - 1)]!;
}

describe("autoGc (the detached sweep orchestration — ADR 0007)", () => {
  it("over the size cap: optimise-first, then gc, pruning the cold recency roots", () => {
    const home = dir();
    const recencyRootsDir = join(home, "recency-roots");
    // total 600 → cap 60, budget 42. warm (30) fits the budget; cold (30 more → 60) is evicted.
    upsertRecency(home, { projectKey: "warm", lastUsedAt: 300, closureBytes: 30 });
    upsertRecency(home, { projectKey: "cold", lastUsedAt: 100, closureBytes: 30 });
    const warmLink = gcRootLink(recencyRootsDir, "warm", "toolchain");
    const coldLink = gcRootLink(recencyRootsDir, "cold", "toolchain");
    mkdirSync(recencyRootsDir, { recursive: true });
    writeFileSync(warmLink, "");
    writeFileSync(coldLink, "");

    const calls: string[][] = [];
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      return args.includes("--optimise") ? OK("", OPTIMISE_OUT) : OK(GC_OUT);
    };

    const report = autoGc({
      run,
      measure: () => 80, // store ≥ cap 60, and optimise doesn't shrink logical size → still over
      disk: diskSeq([{ free: 300, total: 600 }]),
      dir: home,
      recencyRootsDir,
      now: () => 1700000000000,
    });

    expect(report).not.toBe("skipped");
    if (report === "skipped") return;
    expect(report.swept).toBe(true);
    expect(report.reason).toBe("cap");
    expect(calls.map((c) => c[1])).toEqual(["--optimise", "--gc"]); // optimise BEFORE gc
    expect(report.optimise).toEqual({ bytesFreed: 100, filesLinked: 5 });
    expect(report.gc).toEqual({ pathsDeleted: 2, bytesFreed: 4200 });
    expect(report.freedBytes).toBe(4300);
    // The cold recency root was pruned (becomes collectable); the warm one survives.
    expect(existsSync(coldLink)).toBe(false);
    expect(existsSync(warmLink)).toBe(true);
    // The sweep appended a never-silent "freed X" line to the gc log.
    expect(readLastSweepLine(join(home, "gc.log"))).toContain("4300");
  });

  it("over the ceiling: cold deps-cache entries are evicted too (the cache is swept, not just the Store)", () => {
    const home = dir();
    const cacheDir = join(home, "deps-cache");
    // Two lockfile-hash-keyed cache entries (30 bytes each → 60 total). cap (total/10)
    // is 50, so the cache alone trips the cap; the byte-budget (35) keeps the recently
    // -used "hot" entry and evicts the stale one.
    const hot = join(cacheDir, "hotlockhash");
    const stale = join(cacheDir, "stalelockhash");
    mkdirSync(hot, { recursive: true });
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(hot, "node_modules"), "x".repeat(30));
    writeFileSync(join(stale, "node_modules"), "x".repeat(30));
    const t = 1_700_000_000;
    utimesSync(stale, t - 10_000, t - 10_000); // older → cold
    utimesSync(hot, t, t); // newer → warm

    const report = autoGc({
      run: (args) => (args.includes("--optimise") ? OK("", OPTIMISE_OUT) : OK(GC_OUT)),
      measure: () => 0, // Store empty; the CACHE (60) pushes total over the cap (50)
      disk: diskSeq([{ free: 300, total: 500 }]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      depsCacheDir: cacheDir,
      now: () => t * 1000,
    });

    expect(report).not.toBe("skipped");
    if (report === "skipped") return;
    expect(report.swept).toBe(true);
    // The stale (cold) cache entry was evicted; the recently-used one survives.
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(hot)).toBe(true);
  });

  it("optimise alone clears the free-space floor: gc is skipped", () => {
    const home = dir();
    const calls: string[][] = [];
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      return OK("", OPTIMISE_OUT);
    };

    const report = autoGc({
      run,
      measure: () => 20, // store well under the cap (100); optimise leaves logical size unchanged
      // First reading trips the floor (free 5 ≤ 100); after optimise frees disk, free 500 clears it.
      disk: diskSeq([
        { free: 5, total: 1000 },
        { free: 500, total: 1000 },
      ]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      now: () => 1,
    });

    expect(report).not.toBe("skipped");
    if (report === "skipped") return;
    expect(report.swept).toBe(true);
    expect(report.reason).toBe("floor");
    expect(calls.map((c) => c[1])).toEqual(["--optimise"]); // gc NOT run — optimise sufficed
    expect(report.gc).toBeUndefined();
  });

  it("under the ceiling: no store sweep, but the same locked post-run pass prunes flight-recorder logs", () => {
    const home = dir();
    const runsDir = join(home, "runs");
    mkdirSync(runsDir, { recursive: true });
    const oldRun = join(runsDir, "old.jsonl");
    const midRun = join(runsDir, "mid.jsonl");
    const newRun = join(runsDir, "new.jsonl");
    writeFileSync(oldRun, "x".repeat(8));
    writeFileSync(midRun, "x".repeat(4));
    writeFileSync(newRun, "x".repeat(6));
    utimesSync(oldRun, 100, 100);
    utimesSync(midRun, 200, 200);
    utimesSync(newRun, 300, 300);

    const calls: string[][] = [];
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      return OK();
    };

    const report = autoGc({
      run,
      measure: () => 20,
      disk: diskSeq([{ free: 500, total: 1000 }]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      now: () => 1,
      runLogCeilingBytes: 10,
    });

    expect(report).not.toBe("skipped");
    if (report === "skipped") return;
    expect(report.swept).toBe(false);
    expect(report.reason).toBe("none");
    expect(calls).toEqual([]); // store/cache GC did not run
    expect(existsSync(oldRun)).toBe(false); // oldest was evicted to fit the run-log budget
    expect(existsSync(midRun)).toBe(true);
    expect(existsSync(newRun)).toBe(true);
    expect(report.runLogs).toEqual({ bytesBefore: 18, bytesAfter: 10, bytesFreed: 8, runsDeleted: 1 });
  });

  it("skips entirely (returns 'skipped') when another sweep holds the lock", () => {
    const home = dir();
    writeFileSync(join(home, "gc.lock"), String(process.pid)); // a sweep is already active

    const report = autoGc({
      run: () => OK(),
      measure: () => 99,
      disk: diskSeq([{ free: 1, total: 100 }]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      now: () => 1,
    });

    expect(report).toBe("skipped");
  });

  it("is best-effort: a throwing runner surfaces a warn record and never throws", () => {
    const home = dir();
    const root = createMemoryLogger();
    const logger = root.child({ mod: "gc" });
    const throwing = (): NixResult => {
      throw new Error("nix exploded");
    };

    const report = autoGc({
      run: throwing,
      measure: () => 60, // over the cap → it will try to optimise → the runner throws
      disk: diskSeq([{ free: 50, total: 100 }]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      now: () => 1,
      logger,
    });

    expect(report).not.toBe("skipped"); // it ran, it just failed mid-sweep
    expect(root.records.some((r) => r.level === "warn" && r.msg === "sweep failed (best-effort, run unaffected)")).toBe(true);
    // The lock was released despite the failure (a later sweep is not blocked).
    expect(existsSync(join(home, "gc.lock"))).toBe(false);
  });

  it("reaps a dead-owner scratch orphan but spares a live owner's dir (post-run pass, even under the ceiling)", () => {
    const home = dir();
    const scratchTmpDir = dir(); // isolated stand-in for the OS temp dir
    // A SIGKILL'd run's leftover: owner PID 1 (init) is never our live run → reap.
    const orphan = mkdtempSync(join(scratchTmpDir, "dustcastle-build-1-"));
    // A concurrent live build, owned by THIS process → must survive the reaper.
    const live = mkdtempSync(join(scratchTmpDir, `dustcastle-build-${process.pid}-`));

    const report = autoGc({
      run: () => OK(),
      measure: () => 20, // under the ceiling: the store sweep is a no-op...
      disk: diskSeq([{ free: 500, total: 1000 }]),
      dir: home,
      recencyRootsDir: join(home, "recency-roots"),
      now: () => 1_700_000_000_000,
      scratchTmpDir,
    });

    expect(report).not.toBe("skipped");
    expect(existsSync(orphan)).toBe(false); // ...the dead-owner orphan is still reclaimed
    expect(existsSync(live)).toBe(true); // ...and a concurrent live build is never touched
  });
});

describe("readLastSweepLine (the next-run surfacer — ADR 0007)", () => {
  it("returns undefined when the gc log is missing (degrades silently)", () => {
    expect(readLastSweepLine(join(dir(), "gc.log"))).toBeUndefined();
  });

  it("returns the last non-empty line of the gc log", () => {
    const log = join(dir(), "gc.log");
    writeFileSync(log, "old line\nlast sweep freed 999 bytes\n");
    expect(readLastSweepLine(log)).toBe("last sweep freed 999 bytes");
  });
});
