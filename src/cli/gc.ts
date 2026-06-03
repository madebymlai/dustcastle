import { DUSTCASTLE_HOME } from "../config/global.js";
import { noopLogger, type Logger } from "../log/index.js";
import { collectPools } from "../store/pool.js";
import { defaultDepsCacheDir, depsCachePool } from "../store/depscache/index.js";
import { defaultRecencyRootsDir } from "../store/gc.js";
import { nixPortableRunner, type NixRunner } from "../store/nix.js";
import { storePool } from "../store/storePool.js";

/**
 * `dustcastle gc`: the manual, user-invoked store sweep (ADR 0007/0012). Drives the
 * SAME unified pool brain as the auto sweep (`collectPools` over the Store pool and
 * the deps-cache pool) with a ZERO byte budget — so it reclaims everything not pinned.
 * It runs `nix store optimise` (file-level dedup) first (the cache has none), then the
 * per-pool eviction, surfacing what it freed — never silent. Unlike the automatic
 * trigger, there is no disk-ceiling threshold and no recency tail: the user asked
 * explicitly, so it always sweeps.
 *
 * Concurrent-run safety is ASYMMETRIC across the two pools, because their pins differ:
 *   - Store — protected cross-process. A live run's closure is pinned by ON-DISK scoped
 *     roots (`gcroots/`), and `nix-store --gc` honours every root on disk regardless of
 *     which process wrote it. This separate gc process therefore never collects an
 *     in-flight run's toolchain closure.
 *   - Deps cache — NOT protected cross-process. The pool's pins are an in-memory `Set`
 *     on the pool instance (a live run pins its hashes in ITS OWN process); this gc
 *     process builds a fresh pool whose pinned set is empty, so a budget-0 sweep evicts
 *     EVERY cache entry — including ones a concurrent run just restored. That is safe
 *     for correctness — restore copies the deps into the worktree's stageDir before the
 *     sandbox starts, so the running sandbox uses its own copy, not the cache dir — but
 *     it costs that run a re-install/re-populate next time. Acceptable for an explicit
 *     "sweep everything"; surfaced in the output below so it is never a silent surprise.
 *
 * The nix runner and the pool dirs are injectable for tests; production uses a real
 * nix-portable spawn and the dustcastle-owned home + recency-root + deps-cache dirs.
 * Returns a process exit code.
 */
export async function runGcCommand(opts: {
  readonly run?: NixRunner;
  readonly dir?: string;
  readonly recencyRootsDir?: string;
  readonly depsCacheDir?: string;
  readonly logger?: Logger;
} = {}): Promise<number> {
  const logger = opts.logger ?? noopLogger;
  logger.info("sweeping the shared Nix Store + deps cache (optimise → collect-garbage)…");

  const run = opts.run ?? nixPortableRunner();
  const store = storePool({
    run,
    dir: opts.dir ?? DUSTCASTLE_HOME,
    recencyRootsDir: opts.recencyRootsDir ?? defaultRecencyRootsDir(),
    logger: logger.child({ mod: "gc" }),
  });
  const cache = depsCachePool({
    cacheDir: opts.depsCacheDir ?? defaultDepsCacheDir(),
    logger: logger.child({ mod: "deps-cache" }),
  });

  // The deps cache is swept whole: its pins are in-memory, so this separate process
  // can't see a concurrent run's pins (the Store's on-disk roots ARE seen). Flag it
  // up front so a re-install on a running sandbox's next start is never a surprise.
  logger.warn("the deps cache is reclaimed in full; a concurrent run will re-install its deps next time");

  // Budget 0 ⇒ an empty warm tail ⇒ every (unpinned) entry is cold in both pools.
  const report = collectPools([store, cache], { budgetBytes: 0, optimise: true });

  const totalBytesFreed = report.bytesFreed + (report.optimise?.bytesFreed ?? 0);
  logger.info(
    {
      entriesEvicted: report.entriesEvicted,
      filesLinked: report.optimise?.filesLinked ?? 0,
      freedBytes: totalBytesFreed,
    },
    "gc done",
  );
  return 0;
}
