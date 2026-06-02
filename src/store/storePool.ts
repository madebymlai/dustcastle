import {
  collectGarbageArgs,
  optimiseArgs,
  parseGcReport,
  parseOptimiseReport,
  pruneRecencyRoots,
  registerScopedRoots,
  type NixRunner,
  type OptimiseReport,
} from "./gc.js";
import { closureSizeBytes, measureStoreBytes } from "./ceiling.js";
import { loadRecency } from "./recency.js";
import type { Pool, PoolEntry, PoolEvictReport } from "./pool.js";

/**
 * The Store pool (ADR 0012) — the Toolchain Store expressed through the reusable GC
 * pool interface. Its mechanism is today's code (ADR 0007):
 *   - `measure`  → `nix path-info` size accounting (`measureStoreBytes`);
 *   - `entries`  → the recency index (`loadRecency`, mapped to the generic record);
 *   - `pin`      → register scoped GC roots for the Toolchain closure (released on completion);
 *   - `release`  → drop those scoped roots (closure becomes collectable);
 *   - `evict`    → prune the cold recency roots, then `nix-store --gc` (unrooted only);
 *   - `optimise` → `nix store optimise` (file-level hard-link dedup).
 *
 * Because a scoped root pins by closure PATHS, `pin` resolves the key→closure via
 * the `closures` map the caller supplies for the active run; an unknown key is a
 * no-op (best-effort, mirroring the per-root tolerance the roots layer already has).
 */

export interface StoreClosure {
  readonly toolchainStorePath: string;
}

export interface StorePoolOptions {
  /** The nix runner (measure / optimise / gc). Injected in tests; a real spawn in production. */
  readonly run: NixRunner;
  /** The dustcastle home holding the recency index (`recency.json`). */
  readonly dir: string;
  /** Where the persistent recency-root symlinks live (pruned to the warm tail on evict). */
  readonly recencyRootsDir: string;
  /**
   * Where the scoped (per-run) root symlinks live — pinned, released on completion.
   * Optional: the detached sweep never pins (a live run does, via its own pool), so
   * the sweep constructs the pool without it and `pin` becomes a no-op.
   */
  readonly gcrootsDir?: string;
  /**
   * Closures available to `pin` this sweep, keyed by `projectKey`. A live run supplies
   * its own entry here; pinning a key with no closure is a no-op (best-effort).
   */
  readonly closures?: ReadonlyMap<string, StoreClosure>;
  /** Surface progress (never silent — ADR 0007). */
  readonly onLine?: (line: string) => void;
}

/** Construct the Store pool over the existing Store mechanism (ADR 0007/0012). */
export function storePool(opts: StorePoolOptions): Pool {
  const log = opts.onLine ?? (() => {});
  // Track scoped roots per key so `release(key)` can drop exactly that run's roots.
  const pinned = new Map<string, ReturnType<typeof registerScopedRoots>>();

  return {
    measure: () => measureStoreBytes(opts.run),

    entries: (): PoolEntry[] =>
      loadRecency(opts.dir).map((r) => ({ key: r.projectKey, lastUsedAt: r.lastUsedAt, bytes: r.closureBytes })),

    pin: (key: string): void => {
      if (opts.gcrootsDir === undefined) return; // no scoped-root dir (a sweep, not a run) → no-op
      const closure = opts.closures?.get(key);
      if (closure === undefined || pinned.has(key)) return; // unknown / already pinned → no-op
      pinned.set(
        key,
        registerScopedRoots({
          provisioned: closure,
          gcrootsDir: opts.gcrootsDir,
          projectKey: key,
          run: opts.run,
          onLine: log,
        }),
      );
    },

    release: (key: string): void => {
      const handle = pinned.get(key);
      if (handle === undefined) return;
      handle.release();
      pinned.delete(key);
    },

    evict: (keys: readonly string[]): PoolEvictReport => {
      // Prune the cold recency roots so their closures become collectable; the warm
      // tail (the keys NOT passed here) stays rooted and survives the gc. Scoped
      // (pinned) roots are untouched, so a live run's closure is never collected.
      const keep = new Set(loadRecency(opts.dir).map((r) => r.projectKey).filter((k) => !keys.includes(k)));
      pruneRecencyRoots({ recencyRootsDir: opts.recencyRootsDir, keepKeys: [...keep], onLine: log });
      const gcRes = opts.run(collectGarbageArgs());
      const gc = parseGcReport(gcRes.stdout + gcRes.stderr);
      log(`gc: collected ${gc.pathsDeleted} unrooted path(s), freed ${gc.bytesFreed} bytes`);
      return { entriesEvicted: gc.pathsDeleted, bytesFreed: gc.bytesFreed };
    },

    optimise: (): OptimiseReport => {
      const opt = opts.run(optimiseArgs());
      const optimise = parseOptimiseReport(opt.stdout + opt.stderr);
      log(`gc: optimise freed ${optimise.bytesFreed} bytes by hard-linking ${optimise.filesLinked} files`);
      return optimise;
    },
  };
}

/** The closure size (bytes) of a Store closure path — re-exported for keying entries by size. */
export { closureSizeBytes };
