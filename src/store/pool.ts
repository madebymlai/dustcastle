import type { GcReport, OptimiseReport } from "./nix.js";

/**
 * The reusable GC pool interface (ADR 0012). dustcastle's GC is already a pure
 * recency/ceiling/warm-set brain behind an injected mechanism (ADR 0007); this seam
 * generalizes that mechanism into a **pool** so the SAME brain manages more than one
 * resource. In this slice the Store is the sole pool — its `nix-store --gc` /
 * `--optimise` / gc-roots are now expressed through the interface, no behavior
 * change — preparing the seam a deps-cache pool plugs into (ADR 0012, dustcastle-8od).
 *
 * A pool exposes five things the brain drives:
 *   - `measure`  — the pool's total resident size (bytes), the cap half of the ceiling;
 *   - `entries`  — its recency records `{key, lastUsedAt, bytes}`, the warm-set input;
 *   - `pin` / `release` — protect an active entry from eviction (a live run pins the
 *     entry it depends on, released on completion) — a pinned entry is NEVER evicted;
 *   - `evict`    — collect the cold keys (Store: prune cold roots, then `nix-store --gc`);
 *   - `optimise` — optional non-destructive dedup (Store: `nix store optimise`; a pool
 *     with no file-level dedup, like the deps cache, simply omits it).
 *
 * The brain (`collectPool`) is pool-agnostic: it picks the byte-budget warm tail from
 * `entries`, then evicts the rest through `evict` — the pool decides the mechanism.
 */

/** One pool entry's recency record — the warm-set input (ADR 0012's `{key, lastUsedAt, bytes}`). */
export interface PoolEntry {
  /** The entry's stable key within its pool (Store: the Toolchain closure key). */
  readonly key: string;
  /** When this entry was last used by a run (epoch ms) — the LRU order. */
  readonly lastUsedAt: number;
  /** The entry's resident size (bytes) — the byte-budget unit. */
  readonly bytes: number;
}

/**
 * The byte-budget LRU recency tail (ADR 0007 — "the most-recently-used closures
 * that fit a byte budget"). Walks the entries newest-first and keeps each whose
 * bytes still fit under `budgetBytes`, stopping at the first that overflows —
 * exactly LRU eviction (evict the oldest until the total fits). Byte-budget, not
 * count-based, because entries vary wildly in size: a count-based "keep N" is
 * size-blind and would let a few large entries blow the disk. The kept keys are
 * the entries a sweep keeps warm; the rest go cold. `budgetBytes` is the low
 * watermark (a product-derived parameter, never baked in).
 *
 * Edges: a zero budget keeps nothing; a single entry larger than the whole
 * budget is dropped (its key never fits), so the warm set stays bounded by bytes.
 */
export function recencyTailKeys(entries: readonly PoolEntry[], budgetBytes: number): string[] {
  const newestFirst = [...entries].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const keep: string[] = [];
  let spent = 0;
  for (const e of newestFirst) {
    const next = spent + Math.max(0, e.bytes);
    if (next > budgetBytes) break; // LRU: this and every older entry go cold
    spent = next;
    keep.push(e.key);
  }
  return keep;
}

/** What an `evict` (or the whole `collectPool` sweep) reclaimed — surfaced, never silent. */
export interface PoolEvictReport {
  /** How many entries were collected. */
  readonly entriesEvicted: number;
  /** Total bytes reclaimed by the eviction. */
  readonly bytesFreed: number;
}

/**
 * A garbage-collectable pool behind the unified GC brain (ADR 0012). Each pool
 * supplies its own mechanism; the Store pool maps these onto nix-portable, a future
 * deps-cache pool onto lockfile-hash-keyed directories.
 */
export interface Pool {
  /** The pool's total resident size in bytes (the cap half of the disk-derived ceiling). */
  measure(): number;
  /** The pool's recency records — every resident entry, in any order. */
  entries(): PoolEntry[];
  /** Pin an entry so the next sweep cannot evict it (a live run's active entry). */
  pin(key: string): void;
  /** Release a previously pinned entry, making it eligible for eviction again. */
  release(key: string): void;
  /** Evict the given (cold) keys; a pinned entry is never evicted. Returns what was freed. */
  evict(keys: readonly string[]): PoolEvictReport;
  /** Optional non-destructive dedup before eviction (Store: `nix store optimise`). */
  optimise?(): OptimiseReport;
}

/** What a pool sweep reclaimed — the optimise pass (when one ran) plus the eviction. */
export interface PoolSweepReport extends PoolEvictReport {
  /** The optimise pass result, when `optimise` was requested and the pool supports it. */
  readonly optimise?: OptimiseReport;
}

export interface CollectPoolOptions {
  /** The byte budget the warm (recency) set must fit — the low watermark (ADR 0007). */
  readonly budgetBytes: number;
  /** Run the pool's non-destructive `optimise` before evicting. Off by default. */
  readonly optimise?: boolean;
}

/**
 * The pool-agnostic GC brain (ADR 0007's chosen stance, generalized by ADR 0012):
 * "keep the byte-budget recently-used tail; evict the rest." Picks the warm keys via
 * the same `recencyTailKeys` LRU the Store has always used, then evicts every key
 * NOT in that tail through the pool's mechanism — so a pinned (active) entry, even
 * one outside the tail, survives (the pool's `evict` refuses a pinned key). When
 * `optimise` is requested and the pool supports it, the non-destructive dedup runs
 * FIRST (it cannot cause a cold re-fetch). Bakes in no threshold; the budget and the
 * optimise decision are the caller's (the auto-trigger derives them from the disk).
 */
export function collectPool(pool: Pool, opts: CollectPoolOptions): PoolSweepReport {
  let optimise: OptimiseReport | undefined;
  if (opts.optimise === true && pool.optimise !== undefined) {
    optimise = pool.optimise();
  }

  const entries = pool.entries();
  const warm = new Set(recencyTailKeys(entries, opts.budgetBytes));
  const cold = entries.map((e) => e.key).filter((key) => !warm.has(key));
  const evicted = pool.evict(cold);

  return optimise !== undefined ? { ...evicted, optimise } : evicted;
}

/**
 * The unified GC interface over MORE THAN ONE pool (ADR 0012, dustcastle-8od): sweep
 * each pool through the same pool-agnostic brain (`collectPool`) and aggregate what
 * was freed. The Store pool (Toolchain closures) and the deps-cache pool (assembled
 * Project Deps keyed by lockfile hash) plug in side by side, so one recency/ceiling
 * brain manages both — there is no second hand-rolled GC. Each pool keeps its own
 * pins, so a live run that pinned its active entry in EACH pool has neither evicted.
 * The optimise flag is forwarded; a pool with no `optimise` (the deps cache) ignores it.
 */
export function collectPools(pools: readonly Pool[], opts: CollectPoolOptions): PoolSweepReport {
  let entriesEvicted = 0;
  let bytesFreed = 0;
  let optimise: OptimiseReport | undefined;
  for (const pool of pools) {
    const report = collectPool(pool, opts);
    entriesEvicted += report.entriesEvicted;
    bytesFreed += report.bytesFreed;
    // Surface the first pool's optimise pass (the Store's hard-link dedup); the deps
    // cache has none, so it never contributes here.
    if (optimise === undefined && report.optimise !== undefined) optimise = report.optimise;
  }
  return optimise !== undefined ? { entriesEvicted, bytesFreed, optimise } : { entriesEvicted, bytesFreed };
}


