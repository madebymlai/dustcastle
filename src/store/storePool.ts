import { homedir } from "node:os";
import { join } from "node:path";
import {
  collectGarbageArgs,
  optimiseArgs,
  parseGcReport,
  parseOptimiseReport,
  type NixRunner,
  type OptimiseReport,
} from "./nix.js";
import { pruneRecencyRoots, registerScopedRoots } from "./gcRoots.js";
import { measureStoreBytes } from "./ceiling.js";
import { loadRecency } from "./recency.js";
import { noopLogger, type Logger } from "../log/index.js";
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
  /**
   * Where the persistent recency-root symlinks live (pruned to the warm tail on evict).
   * Defaults to `~/.dustcastle/recency-roots`.
   */
  readonly recencyRootsDir?: string;
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
  /** Structured progress logs. */
  readonly logger?: Logger;
}

const DEFAULT_GCROOTS_DIR = join(homedir(), ".dustcastle", "gcroots");
const DEFAULT_RECENCY_ROOTS_DIR = join(homedir(), ".dustcastle", "recency-roots");

/** Construct the Store pool over the existing Store mechanism (ADR 0007/0012). */
export function storePool(opts: StorePoolOptions): Pool {
  const logger = opts.logger ?? noopLogger;
  const gcrootsDir = opts.gcrootsDir ?? DEFAULT_GCROOTS_DIR;
  const recencyRootsDir = opts.recencyRootsDir ?? DEFAULT_RECENCY_ROOTS_DIR;
  // Track scoped roots per key so `release(key)` can drop exactly that run's roots.
  const pinned = new Map<string, ReturnType<typeof registerScopedRoots>>();

  return {
    measure: () => measureStoreBytes(opts.run),

    entries: (): PoolEntry[] =>
      loadRecency(opts.dir).map((r) => ({ key: r.projectKey, lastUsedAt: r.lastUsedAt, bytes: r.closureBytes })),

    pin: (key: string): void => {
      const closure = opts.closures?.get(key);
      if (closure === undefined || pinned.has(key)) return; // unknown / already pinned → no-op
      pinned.set(
        key,
        registerScopedRoots({
          provisioned: closure,
          gcrootsDir,
          projectKey: key,
          run: opts.run,
          logger,
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
      const cold = new Set(keys);
      const keep = loadRecency(opts.dir)
        .map((r) => r.projectKey)
        .filter((key) => !cold.has(key));
      pruneRecencyRoots({ recencyRootsDir, keepKeys: keep, logger });
      const gcRes = opts.run(collectGarbageArgs());
      const gc = parseGcReport(gcRes.stdout + gcRes.stderr);
      logger.debug({ pathsDeleted: gc.pathsDeleted, bytesFreed: gc.bytesFreed }, "collected unrooted store paths");
      return { entriesEvicted: gc.pathsDeleted, bytesFreed: gc.bytesFreed };
    },

    optimise: (): OptimiseReport => {
      const opt = opts.run(optimiseArgs());
      const optimise = parseOptimiseReport(opt.stdout + opt.stderr);
      logger.debug({ bytesFreed: optimise.bytesFreed, filesLinked: optimise.filesLinked }, "optimise hard-linked store files");
      return optimise;
    },
  };
}

