import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gcRootLink } from "./gc.js";
import type { NixResult } from "./nix.js";
import { collectPool } from "./pool.js";
import { storePool, type StoreClosure } from "./storePool.js";
import { upsertRecency } from "./recency.js";

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
});
