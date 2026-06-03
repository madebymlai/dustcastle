import { describe, expect, it } from "vitest";
import { collectPool, collectPools, recencyTailKeys, type Pool, type PoolEntry } from "./pool.js";

// The pool interface (ADR 0012) generalizes the Store GC into a reusable seam: the
// pure recency/ceiling/warm-set brain (`collectPool`) drives ANY pool implementation
// through `measure` · `entries` · `pin`/`release` · `evict` · optional `optimise`.
// In this slice the Store is the sole pool; these tests pin the interface contract
// pool-agnostically (no nix, no disk) so a second pool can plug into the same brain.

describe("recencyTailKeys (the byte-budget LRU warm set in PoolEntry vocabulary — ADR 0007)", () => {
  it("keeps the newest entries that fit the byte budget, dropping the older rest", () => {
    const entries = [
      { key: "npm-old", lastUsedAt: 100, bytes: 300 },
      { key: "npm-new", lastUsedAt: 300, bytes: 400 },
      { key: "npm-mid", lastUsedAt: 200, bytes: 400 },
    ];
    // Budget 900: newest (400) + mid (400) = 800 fit; old (→1100) overflows → cold.
    expect(recencyTailKeys(entries, 900)).toEqual(["npm-new", "npm-mid"]);
  });

  it("keeps nothing under a zero budget", () => {
    const entries = [{ key: "npm-a", lastUsedAt: 1, bytes: 10 }];
    expect(recencyTailKeys(entries, 0)).toEqual([]);
  });

  it("drops a single entry larger than the whole budget (size-bounded, not count)", () => {
    const entries = [
      { key: "huge-new", lastUsedAt: 300, bytes: 5000 },
      { key: "small-old", lastUsedAt: 100, bytes: 100 },
    ];
    // The newest is oversize so it (and every older one, by LRU) cannot be kept.
    expect(recencyTailKeys(entries, 1000)).toEqual([]);
  });
});

/**
 * An in-memory pool fake: entries are a key→bytes map, pins are a set, and `evict`
 * deletes only UNPINNED keys (a pinned/active entry must never be collected). It
 * records its calls so the conformance test can assert the brain's call sequence.
 */
function fakePool(initial: Array<{ key: string; lastUsedAt: number; bytes: number }>): Pool & {
  readonly pinned: Set<string>;
  readonly evicted: string[];
  optimiseCount: number;
  readonly keys: () => string[];
} {
  const store = new Map<string, { lastUsedAt: number; bytes: number }>();
  for (const e of initial) store.set(e.key, { lastUsedAt: e.lastUsedAt, bytes: e.bytes });
  const pinned = new Set<string>();
  const evicted: string[] = [];
  let optimiseCount = 0;
  return {
    pinned,
    evicted,
    keys: () => [...store.keys()],
    get optimiseCount() {
      return optimiseCount;
    },
    set optimiseCount(n: number) {
      optimiseCount = n;
    },
    measure: () => [...store.values()].reduce((sum, v) => sum + v.bytes, 0),
    entries: (): PoolEntry[] =>
      [...store.entries()].map(([key, v]) => ({ key, lastUsedAt: v.lastUsedAt, bytes: v.bytes })),
    pin: (key: string) => {
      pinned.add(key);
    },
    release: (key: string) => {
      pinned.delete(key);
    },
    evict: (keys: readonly string[]) => {
      let bytesFreed = 0;
      let count = 0;
      for (const key of keys) {
        if (pinned.has(key)) continue; // a pinned (active) entry is never evicted
        const v = store.get(key);
        if (v === undefined) continue;
        store.delete(key);
        evicted.push(key);
        bytesFreed += v.bytes;
        count += 1;
      }
      return { entriesEvicted: count, bytesFreed };
    },
    optimise: () => {
      optimiseCount += 1;
      return { bytesFreed: 0, filesLinked: 0 };
    },
  };
}

describe("Pool conformance (the reusable GC seam — ADR 0012)", () => {
  it("a pinned (active) entry is NEVER evicted, even when it falls outside the warm tail", () => {
    // Budget 100 keeps only the newest (50); the older two fall outside the tail.
    const pool = fakePool([
      { key: "new", lastUsedAt: 300, bytes: 50 },
      { key: "mid", lastUsedAt: 200, bytes: 60 },
      { key: "old", lastUsedAt: 100, bytes: 60 },
    ]);
    // "old" is the live run's entry — pinned, so it must survive the sweep.
    pool.pin("old");

    collectPool(pool, { budgetBytes: 100 });

    // The warm tail kept "new"; "mid" is cold and evicted; "old" is cold BUT pinned,
    // so the brain never evicts it (the pool's evict also refuses a pinned key).
    expect(pool.evicted).toContain("mid");
    expect(pool.evicted).not.toContain("old");
    expect(pool.keys()).toContain("old");
  });

  it("evicts the cold entries outside the byte-budget warm tail, keeping the newest that fit", () => {
    const pool = fakePool([
      { key: "a", lastUsedAt: 100, bytes: 300 },
      { key: "b", lastUsedAt: 300, bytes: 400 },
      { key: "c", lastUsedAt: 200, bytes: 400 },
    ]);
    // Budget 900: newest b (400) + c (400) = 800 fit; a (→1100) overflows → cold.
    const report = collectPool(pool, { budgetBytes: 900 });

    expect(pool.evicted).toEqual(["a"]);
    expect(report.bytesFreed).toBe(300);
    expect(report.entriesEvicted).toBe(1);
  });

  it("optimises first when requested, before evicting", () => {
    const pool = fakePool([{ key: "x", lastUsedAt: 1, bytes: 10 }]);
    collectPool(pool, { budgetBytes: 0, optimise: true });
    expect(pool.optimiseCount).toBe(1);
  });

  it("does not optimise when not requested", () => {
    const pool = fakePool([{ key: "x", lastUsedAt: 1, bytes: 10 }]);
    collectPool(pool, { budgetBytes: 1000 });
    expect(pool.optimiseCount).toBe(0);
  });
});

describe("collectPools — one brain over Store + deps-cache (ADR 0012, dustcastle-8od)", () => {
  // The unified GC interface (ADR 0012): the SAME recency/ceiling brain sweeps both
  // pools (the Store/Toolchain pool and the deps-cache pool). A live run pins its
  // active entries in BOTH pools, and the cross-pool sweep evicts only the cold tail of
  // each while NEVER evicting a pinned (active) entry — in either pool.
  it("evicts each pool's cold tail but never an active pin, across both pools", () => {
    // The Store pool: a live toolchain closure (pinned) + a cold one.
    const store = fakePool([
      { key: "tc-live", lastUsedAt: 300, bytes: 50 },
      { key: "tc-cold", lastUsedAt: 100, bytes: 50 },
    ]);
    // The deps-cache pool: the same run's assembled deps (pinned) + a cold entry.
    const cache = fakePool([
      { key: "deps-live", lastUsedAt: 300, bytes: 50 },
      { key: "deps-cold", lastUsedAt: 100, bytes: 50 },
    ]);
    // The live run pins its active entry in BOTH pools.
    store.pin("tc-live");
    cache.pin("deps-live");

    // Budget 50 keeps only the newest entry per pool; the older one is cold.
    const reports = collectPools([store, cache], { budgetBytes: 50 });

    // Each pool evicted its cold entry...
    expect(store.evicted).toEqual(["tc-cold"]);
    expect(cache.evicted).toEqual(["deps-cold"]);
    // ...and NEITHER pinned (active) entry was evicted.
    expect(store.keys()).toContain("tc-live");
    expect(cache.keys()).toContain("deps-live");
    // The aggregate report sums both pools' freed bytes.
    expect(reports.bytesFreed).toBe(100);
    expect(reports.entriesEvicted).toBe(2);
  });
});
