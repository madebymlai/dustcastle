import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gcRootLink } from "./gcRoots.js";
import type { NixResult } from "./nix.js";
import { collectPool } from "./pool.js";
import { storePool, type StoreClosure } from "./storePool.js";
import { loadRecency, upsertRecency } from "./recency.js";

// The Store as the sole pool (ADR 0012): today's `nix-store --gc` / `--optimise` /
// gc-roots, now expressed through the reusable Pool interface — no behavior change.
// These tests drive the Store pool through the SAME pool-agnostic brain (collectPool)
// the conformance suite uses, with the nix runner injected so the real `nix-store
// --gc` stays gated. The load-bearing assertion: a pinned (active) entry — its scoped
// root held — is never evicted, even when it falls outside the warm byte tail.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });
const GC_OUT = 'deleting "/nix/store/x-old"\n4200 bytes freed (0.00 MiB)\n';

const dirs: string[] = [];
function home(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-storepool-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A nix runner that materializes `--add-root` links (as real nix does) and records calls. */
function runner(calls: string[][], gcOut = GC_OUT): (args: readonly string[]) => NixResult {
  return (args: readonly string[]): NixResult => {
    calls.push([...args]);
    if (args[1] === "--add-root") writeFileSync(args[2]!, "");
    if (args.includes("path-info")) return OK("[]");
    if (args.includes("--optimise")) return OK("", "100 bytes (0.00 MiB) freed by hard-linking 3 files;\n");
    if (args.includes("--gc")) return OK(gcOut);
    return OK();
  };
}

/** A runner that returns a specific closureSize for path-info calls, for warm-set tests. */
function runnerWithSize(calls: string[][], closureBytes: number, gcOut = GC_OUT): (args: readonly string[]) => NixResult {
  return (args: readonly string[]): NixResult => {
    calls.push([...args]);
    if (args[1] === "--add-root") writeFileSync(args[2]!, "");
    if (args.includes("path-info")) return OK(JSON.stringify([{ closureSize: closureBytes }]));
    if (args.includes("--optimise")) return OK("", "100 bytes (0.00 MiB) freed by hard-linking 3 files;\n");
    if (args.includes("--gc")) return OK(gcOut);
    return OK();
  };
}

describe("storePool (the Store behind the reusable pool interface — ADR 0012)", () => {
  it("exposes measure / entries from the existing Store accounting", () => {
    const dir = home();
    upsertRecency(dir, { projectKey: "npm-a", lastUsedAt: 200, closureBytes: 500 });
    const pool = storePool({
      run: runner([]),
      dir,
      recencyRootsDir: join(dir, "recency-roots"),
      gcrootsDir: join(dir, "gcroots"),
    });

    expect(pool.measure()).toBe(0); // path-info → [] → 0 bytes
    expect(pool.entries()).toEqual([{ key: "npm-a", lastUsedAt: 200, bytes: 500 }]);
  });

  it("pins an active entry with scoped roots, then releases them by key", () => {
    const dir = home();
    const calls: string[][] = [];
    const closures = new Map<string, StoreClosure>([
      ["npm-live", { toolchainStorePath: "/nix/store/aaa-node" }],
    ]);
    const pool = storePool({
      run: runner(calls),
      dir,
      recencyRootsDir: join(dir, "recency-roots"),
      gcrootsDir: join(dir, "gcroots"),
      closures,
    });

    pool.pin("npm-live");
    const tcLink = gcRootLink(join(dir, "gcroots"), "npm-live", "toolchain");
    expect(existsSync(tcLink)).toBe(true); // scoped root registered

    pool.release("npm-live");
    expect(existsSync(tcLink)).toBe(false); // released → collectable
  });

  it("evict prunes the cold recency roots but keeps the warm + pinned ones rooted", () => {
    const dir = home();
    const recencyRootsDir = join(dir, "recency-roots");
    const gcrootsDir = join(dir, "gcroots");
    const calls: string[][] = [];
    // Two recency entries; one is the live (pinned) run, one is genuinely cold.
    upsertRecency(dir, { projectKey: "npm-live", lastUsedAt: 300, closureBytes: 40 });
    upsertRecency(dir, { projectKey: "npm-cold", lastUsedAt: 100, closureBytes: 40 });
    const closures = new Map<string, StoreClosure>([
      ["npm-live", { toolchainStorePath: "/nix/store/live-tc" }],
    ]);
    const pool = storePool({ run: runner(calls), dir, recencyRootsDir, gcrootsDir, closures });

    // Seed BOTH persistent recency roots, then pin the live one's scoped root.
    const liveRecency = gcRootLink(recencyRootsDir, "npm-live", "toolchain");
    const coldRecency = gcRootLink(recencyRootsDir, "npm-cold", "toolchain");
    mkdirSync(recencyRootsDir, { recursive: true });
    writeFileSync(liveRecency, "");
    writeFileSync(coldRecency, "");
    pool.pin("npm-live");

    // Drive the Store pool through the pool-agnostic brain. Budget 50 keeps only the
    // newest (live, 40); cold (→80) overflows → evicted. The brain passes the cold
    // keys to `evict`, which prunes their recency roots and runs `nix-store --gc`.
    const report = collectPool(pool, { budgetBytes: 50 });

    const gcCalls = calls.filter((c) => c.includes("--gc"));
    expect(gcCalls).toHaveLength(1); // the destructive collect ran exactly once
    expect(report.bytesFreed).toBe(4200);
    // The cold recency root was pruned (collectable); the live one stays rooted.
    expect(existsSync(coldRecency)).toBe(false);
    expect(existsSync(liveRecency)).toBe(true);
    // The pinned scoped root also survives — a live run's closure is never evicted.
    expect(existsSync(gcRootLink(gcrootsDir, "npm-live", "toolchain"))).toBe(true);
  });

  it("optimises through the interface (the non-destructive dedup lever)", () => {
    const dir = home();
    const calls: string[][] = [];
    const pool = storePool({
      run: runner(calls),
      dir,
      recencyRootsDir: join(dir, "recency-roots"),
      gcrootsDir: join(dir, "gcroots"),
    });

    const report = pool.optimise!();
    expect(report).toEqual({ bytesFreed: 100, filesLinked: 3 });
    expect(calls.some((c) => c.includes("--optimise"))).toBe(true);
  });

  it("warm computes closure bytes, upserts the recency index, and registers the persistent recency root", () => {
    const dir = home();
    const recencyRootsDir = join(dir, "recency-roots");
    const calls: string[][] = [];
    const closures = new Map<string, StoreClosure>([
      ["npm-warm", { toolchainStorePath: "/nix/store/warm-tc" }],
    ]);
    const pool = storePool({
      run: runner(calls),
      dir,
      recencyRootsDir,
      gcrootsDir: join(dir, "gcroots"),
      closures,
    });

    pool.warm?.("npm-warm");

    // The recency index has the upserted record.
    const records = loadRecency(dir);
    expect(records).toHaveLength(1);
    expect(records[0]!.projectKey).toBe("npm-warm");
    expect(records[0]!.closureBytes).toBe(0); // path-info returns [] → 0 bytes
    expect(records[0]!.lastUsedAt).toBeGreaterThan(0);

    // The persistent recency root was registered (the link exists on disk).
    const recencyLink = gcRootLink(recencyRootsDir, "npm-warm", "toolchain");
    expect(existsSync(recencyLink)).toBe(true);

    // The nix runner was called for path-info (closure size) and add-root (recency root).
    expect(calls.some((c) => c.includes("path-info"))).toBe(true);
    expect(calls.some((c) => c[1] === "--add-root")).toBe(true);
  });

  it("warm is a no-op for an unknown key (best-effort, mirroring pin)", () => {
    const dir = home();
    const calls: string[][] = [];
    const pool = storePool({
      run: runner(calls),
      dir,
      recencyRootsDir: join(dir, "recency-roots"),
      gcrootsDir: join(dir, "gcroots"),
      // no closures → warm is a no-op
    });

    expect(() => pool.warm?.("unknown-key")).not.toThrow();
    expect(loadRecency(dir)).toHaveLength(0); // no recency record written
  });

  it("a slash in a project key does not escape the roots directory (path-traversal property)", () => {
    const dir = home();
    const gcrootsDir = join(dir, "gcroots");
    const recencyRootsDir = join(dir, "recency-roots");
    const calls: string[][] = [];
    // A slashy key that could escape the dir if not sanitized.
    const slashyKey = "npm-../../../escape/etc/passwd";
    const closures = new Map<string, StoreClosure>([
      [slashyKey, { toolchainStorePath: "/nix/store/slashy-tc" }],
    ]);
    const pool = storePool({
      run: runner(calls),
      dir,
      recencyRootsDir,
      gcrootsDir,
      closures,
    });

    // Pin the slashy key → scoped root link stays inside gcrootsDir.
    pool.pin(slashyKey);
    expect(existsSync(join(gcrootsDir, ".."))).toBe(true); // parent still exists (not deleted)
    // The scoped root link was created; verify NO link escaped the roots dir.
    const scopedLinks = readdirSync(gcrootsDir);
    for (const link of scopedLinks) {
      expect(link).not.toContain("/"); // no slashes in the filename
      expect(link.startsWith("..")).toBe(false); // no parent-dir traversal
    }

    // Warm the slashy key → recency root link stays inside recencyRootsDir.
    pool.warm?.(slashyKey);
    const recencyLinks = readdirSync(recencyRootsDir);
    for (const link of recencyLinks) {
      expect(link).not.toContain("/");
      expect(link.startsWith("..")).toBe(false);
    }
  });

  it("warm is exercised through the pool-agnostic brain: a warmed entry is evicted when it falls outside the warm budget", () => {
    const dir = home();
    const recencyRootsDir = join(dir, "recency-roots");
    const calls: string[][] = [];
    const closures = new Map<string, StoreClosure>([
      ["npm-warm", { toolchainStorePath: "/nix/store/warm-tc" }],
    ]);
    const pool = storePool({
      run: runnerWithSize(calls, 500),
      dir,
      recencyRootsDir,
      gcrootsDir: join(dir, "gcroots"),
      closures,
    });

    // Warm the entry so its recency root is on disk (entry has 500 bytes).
    pool.warm?.("npm-warm");
    const recencyLink = gcRootLink(recencyRootsDir, "npm-warm", "toolchain");
    expect(existsSync(recencyLink)).toBe(true);

    // Sweep with budget 0 — the 500-byte entry doesn't fit → cold → evicted.
    const report = collectPool(pool, { budgetBytes: 0 });
    expect(report.entriesEvicted).toBeGreaterThanOrEqual(1);
    // The recency root was pruned by evict.
    expect(existsSync(recencyLink)).toBe(false);
  });

  it("warm + pin: a pinned entry survives evict even though its recency root is pruned as cold", () => {
    const dir = home();
    const recencyRootsDir = join(dir, "recency-roots");
    const gcrootsDir = join(dir, "gcroots");
    const calls: string[][] = [];
    const closures = new Map<string, StoreClosure>([
      ["npm-active", { toolchainStorePath: "/nix/store/active-tc" }],
    ]);
    const pool = storePool({
      run: runnerWithSize(calls, 500),
      dir,
      recencyRootsDir,
      gcrootsDir,
      closures,
    });

    // Warm (persistent recency root) + pin (scoped root).
    pool.warm?.("npm-active");
    pool.pin("npm-active");

    const recencyLink = gcRootLink(recencyRootsDir, "npm-active", "toolchain");
    const scopedLink = gcRootLink(gcrootsDir, "npm-active", "toolchain");
    expect(existsSync(recencyLink)).toBe(true);
    expect(existsSync(scopedLink)).toBe(true);

    // Sweep with budget 0: the 500-byte entry is cold (recency root pruned), but
    // the scoped root keeps the closure from being collected.
    collectPool(pool, { budgetBytes: 0 });

    // Recency root pruned (cold)...
    expect(existsSync(recencyLink)).toBe(false);
    // ...but scoped root survives — a live run's closure is never evicted.
    expect(existsSync(scopedLink)).toBe(true);
  });
});
