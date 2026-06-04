import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectPool } from "../pool.js";
import { depsCachePool } from "./index.js";

// The deps-cache pool (ADR 0012, dustcastle-8od): the SECOND pool behind the reusable
// GC interface. Its mechanism is deps-fingerprint-keyed directories under the dustcastle
// home — `evict` removes a dir, there is no `optimise`. These tests drive it through
// the SAME pool-agnostic brain (collectPool) the Store pool uses, so one recency/
// ceiling brain manages both. The load-bearing assertion: a pinned (active) entry —
// a live run's deps-cache entry — is never evicted, even when it falls outside the
// warm byte tail.

const dirs: string[] = [];
function cacheRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-depscache-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Seed a cache entry `<root>/<hash>/<stageDir>` with one file, so it has a size on disk. */
function seedEntry(root: string, hash: string, stageDir: string, bytes: number): void {
  const dir = join(root, hash, stageDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pkg"), "x".repeat(bytes));
}

describe("depsCachePool (the deps cache behind the reusable pool interface — ADR 0012)", () => {
  it("entries are one per deps-fingerprint directory, sized + timestamped from disk", () => {
    const root = cacheRoot();
    seedEntry(root, "hashA", "node_modules", 100);
    seedEntry(root, "hashB", "site", 50);
    const pool = depsCachePool({ cacheDir: root });

    const keys = pool.entries().map((e) => e.key).sort();
    expect(keys).toEqual(["hashA", "hashB"]);
    // Each entry's bytes is the resident size of its hash dir (> the file payload).
    const byKey = new Map(pool.entries().map((e) => [e.key, e]));
    expect(byKey.get("hashA")!.bytes).toBeGreaterThanOrEqual(100);
    expect(byKey.get("hashB")!.bytes).toBeGreaterThanOrEqual(50);
    // measure() is the total resident size — the cap half of the ceiling.
    expect(pool.measure()).toBe(byKey.get("hashA")!.bytes + byKey.get("hashB")!.bytes);
  });

  it("an empty / missing cache dir yields no entries and zero bytes (degrade, never throw)", () => {
    const pool = depsCachePool({ cacheDir: join(cacheRoot(), "does-not-exist") });
    expect(pool.entries()).toEqual([]);
    expect(pool.measure()).toBe(0);
  });

  it("evicts a cold entry by REMOVING its deps-fingerprint directory", () => {
    const root = cacheRoot();
    seedEntry(root, "cold", "node_modules", 100);
    const pool = depsCachePool({ cacheDir: root });

    const report = pool.evict(["cold"]);

    expect(report.entriesEvicted).toBe(1);
    expect(report.bytesFreed).toBeGreaterThanOrEqual(100);
    expect(existsSync(join(root, "cold"))).toBe(false);
  });

  it("never evicts a pinned (active) entry, even when asked to", () => {
    const root = cacheRoot();
    seedEntry(root, "live", "node_modules", 100);
    const pool = depsCachePool({ cacheDir: root });

    pool.pin("live");
    const report = pool.evict(["live"]);

    expect(report.entriesEvicted).toBe(0);
    expect(existsSync(join(root, "live"))).toBe(true);
    // Released → collectable again.
    pool.release("live");
    pool.evict(["live"]);
    expect(existsSync(join(root, "live"))).toBe(false);
  });

  it("has no optimise lever (no file-level dedup across lockfiles — out of scope)", () => {
    const pool = depsCachePool({ cacheDir: cacheRoot() });
    expect(pool.optimise).toBeUndefined();
  });

  it("driven by the pool-agnostic brain: evicts the cold tail, keeps the warm + pinned", () => {
    const root = cacheRoot();
    // Three entries; the brain keeps the byte-budget recency tail and evicts the rest.
    seedEntry(root, "new", "node_modules", 40);
    seedEntry(root, "mid", "site", 40);
    seedEntry(root, "old", "vendor", 40);
    const pool = depsCachePool({
      cacheDir: root,
      // Recency injected (tests): newest-first new > mid > old.
      lastUsedAt: { new: 300, mid: 200, old: 100 },
    });
    // "old" is the live run's entry — pinned, so it survives even though it is coldest.
    pool.pin("old");

    // Budget keeps only the newest entry; mid + old are cold, but old is pinned.
    collectPool(pool, { budgetBytes: pool.entries().find((e) => e.key === "new")!.bytes });

    expect(existsSync(join(root, "new"))).toBe(true);
    expect(existsSync(join(root, "mid"))).toBe(false); // cold → evicted
    expect(existsSync(join(root, "old"))).toBe(true); // cold BUT pinned
  });
});
