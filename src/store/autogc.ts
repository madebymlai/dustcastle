import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, type Logger } from "../log/index.js";
import { pruneRunLogs, type PruneRunLogsReport } from "../log/retention.js";
import { sweepOrphanedScratch } from "./scratch.js";
import { overCeiling, recencyBudgetBytes, type CeilingReason } from "./ceiling.js";
import type { GcReport, OptimiseReport, NixRunner } from "./nix.js";
import { collectPool } from "./pool.js";
import { depsCachePool } from "./depscache/index.js";
import { storePool } from "./storePool.js";

/**
 * The detached one-shot's orchestration (ADR 0007). After each `dustcastle run`,
 * a background `__autogc` child runs this off the hot path: it measures the Store,
 * decides via the pure brain whether it is over the disk-derived hybrid ceiling,
 * and if so sweeps — optimise-first (non-destructive dedup), re-check, then the
 * destructive `nix-store --gc` ONLY if still over, after pruning the cold recency
 * roots so the warm set survives. It records a one-line "freed X" to the gc log the
 * next run surfaces.
 *
 * Everything is injected (nix runner, store-size measure, disk statfs, clock, dirs)
 * so the whole command sequence is unit-tested and the real `nix-store --gc` stays
 * gated. Safety is structural:
 *   - a `gc.lock` serializes sweeps — an existing lock means another sweep (or a
 *     live run) is active, so this one returns `"skipped"`;
 *   - the whole sweep is best-effort: any failure surfaces a warn record and returns a
 *     no-op report — it can never throw out of the child (and the child is detached
 *     from the run, so it can never break a run either).
 */

/** What a sweep did — surfaced, never silent (ADR 0007). `"skipped"` means the lock was held. */
export interface AutoGcReport {
  /** Did a collect/optimise actually run? (False when the store was under the ceiling.) */
  readonly swept: boolean;
  /** Which half of the hybrid ceiling fired (or `"none"`). */
  readonly reason: CeilingReason;
  /** The Store size measured before the sweep (bytes). */
  readonly storeBytes: number;
  /** Total bytes reclaimed from Store/deps-cache (optimise + gc/cache eviction). */
  readonly freedBytes: number;
  /** Flight-recorder retention report from the same locked post-run sweep. */
  readonly runLogs?: PruneRunLogsReport;
  /** The optimise pass result, when one ran. */
  readonly optimise?: OptimiseReport;
  /** The collect-garbage result, when gc ran (skipped if optimise alone cleared the ceiling). */
  readonly gc?: GcReport;
}

export interface AutoGcOptions {
  /** The nix runner (optimise / gc). Injected in tests; the child passes a real nix-portable spawn. */
  readonly run: NixRunner;
  /** Measure the Store size in bytes (nix accounting, not a du walk). */
  readonly measure: () => number;
  /** Read free/total bytes on the Store's filesystem (statfs). */
  readonly disk: () => { readonly free: number; readonly total: number };
  /** The dustcastle home (holds `recency.json`, `gc.lock`, `gc.log`). */
  readonly dir: string;
  /** Where the persistent recency roots live (pruned to the warm budget before collecting). Defaults to `~/.dustcastle/recency-roots` inside `storePool`. */
  readonly recencyRootsDir?: string;
  /**
   * The deps-cache root (ADR 0012): the second managed pool, swept by the SAME brain as
   * the Store. The cache shares the disk, so its bytes count toward the ceiling, and its
   * cold (byte-LRU) entries are evicted in the destructive phase. Absent ⇒ no cache pool
   * (the Store is the sole pool, as before).
   */
  readonly depsCacheDir?: string;
  /** The clock (epoch ms), injected so the gc-log line is deterministic in tests. */
  readonly now: () => number;
  /** Structured progress logs. */
  readonly logger?: Logger;
  /** Override the lock path (defaults to `<dir>/gc.lock`). */
  readonly lockPath?: string;
  /** Override the gc-log path (defaults to `<dir>/gc.log`). */
  readonly gcLogPath?: string;
  /** Override the flight-recorder runs dir (defaults to `<dir>/runs`). */
  readonly runLogDir?: string;
  /** Override the flight-recorder retention ceiling (defaults to 16 MiB). */
  readonly runLogCeilingBytes?: number;
  /**
   * The dir holding throwaway provisioning scratch trees (defaults to the OS temp dir).
   * The post-run pass reaps crash-leaked orphans here — the SIGKILL/OOM case where the
   * in-process `withTempDir` cleanup could not run. Injected in tests.
   */
  readonly scratchTmpDir?: string;
  /** Override the scratch-orphan staleness threshold (defaults to 6h inside the reaper). */
  readonly scratchMaxAgeMs?: number;
}

const NOOP: AutoGcReport = { swept: false, reason: "none", storeBytes: 0, freedBytes: 0 };

export function autoGc(opts: AutoGcOptions): AutoGcReport | "skipped" {
  const logger = opts.logger ?? noopLogger;
  const lockPath = opts.lockPath ?? join(opts.dir, "gc.lock");
  mkdirSync(opts.dir, { recursive: true });

  // Serialize sweeps with an exclusive lockfile. An existing lock means another
  // sweep — or a live run — is active, so we skip (a stale lock is tolerated: the
  // next sweep after this process exits cleans up its own).
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      logger.info({ event: "skipped", reason: "lock-held" }, "another sweep is active — skipping");
    } else {
      logger.warn({ err: (e as Error).message }, "could not acquire lock");
    }
    return "skipped";
  }

  try {
    // Reap crash-leaked provisioning scratch orphans first — independent of the Store
    // ceiling and best-effort, so it runs on every locked pass even if `sweep` throws.
    reapScratchOrphans(opts, logger);
    return sweep(opts, logger);
  } catch (e) {
    // Best-effort: a failed/hung Store/cache sweep must never throw out of the detached child.
    // Still run the flight-recorder prune under the lock; the two cleanups share the
    // one post-run lifecycle, but recorder retention is independent of pool GC.
    logger.warn({ err: (e as Error).message }, "sweep failed (best-effort, run unaffected)");
    return { ...NOOP, runLogs: pruneFlightRecorderLogs(opts, logger) };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    rmSync(lockPath, { force: true }); // release the lock for the next sweep
  }
}

/** The sweep body (runs under the lock): plan → optimise-first → re-check → conditional gc → prune → log. */
function sweep(opts: AutoGcOptions, logger: Logger): AutoGcReport {
  // The two managed pools behind ONE brain (ADR 0012): the Store (Toolchain closures)
  // and the deps cache (assembled Project Deps, deps-fingerprint-keyed). The Store keeps
  // the injected `measure` as its ceiling input (the nix accounting the child wires);
  // its mechanism (optimise / prune cold roots + `nix-store --gc`) lives in `storePool`.
  // The cache shares the disk, so its bytes count toward the cap and its cold tail is
  // evicted alongside the Store. Absent ⇒ the Store is the sole pool, as before.
  const store = storePool({ run: opts.run, dir: opts.dir, ...(opts.recencyRootsDir !== undefined ? { recencyRootsDir: opts.recencyRootsDir } : {}), logger });
  const cache = opts.depsCacheDir !== undefined ? depsCachePool({ cacheDir: opts.depsCacheDir, logger }) : undefined;
  const cacheBytes = (): number => cache?.measure() ?? 0;

  const storeBytes = opts.measure();
  const { free, total } = opts.disk();
  const budgetBytes = recencyBudgetBytes({ totalBytes: total });

  const before = overCeiling({ storeBytes: storeBytes + cacheBytes(), freeBytes: free, totalBytes: total });
  if (!before.over) {
    logger.info({ storeBytes: storeBytes + cacheBytes() }, "store+cache within ceiling — nothing to sweep");
    const runLogs = pruneFlightRecorderLogs(opts, logger);
    return { swept: false, reason: before.reason, storeBytes, freedBytes: 0, runLogs };
  }
  logger.info({ reason: before.reason, storeBytes: storeBytes + cacheBytes() }, "over ceiling — sweeping");

  // optimise-first: the Store's non-destructive hard-link dedup (the cache has none).
  // It cannot cause a cold rebuild, so it runs before any destructive eviction.
  const optimise = store.optimise!();

  // Re-check against fresh readings — optimise frees disk (the floor half) without
  // shrinking the logical store+cache size (the cap half).
  const after = opts.disk();
  const still = overCeiling({ storeBytes: opts.measure() + cacheBytes(), freeBytes: after.free, totalBytes: after.total });

  let gc: GcReport | undefined;
  let cacheFreed = 0;
  if (still.over) {
    // Evict each pool's cold byte-LRU tail through the SAME brain (`collectPool`): the
    // Store prunes its cold recency roots + `nix-store --gc`; the cache removes its cold
    // entry dirs. A recently-used (warm) entry survives in either pool.
    const storeSweep = collectPool(store, { budgetBytes });
    gc = { pathsDeleted: storeSweep.entriesEvicted, bytesFreed: storeSweep.bytesFreed };
    if (cache !== undefined) cacheFreed = collectPool(cache, { budgetBytes }).bytesFreed;
  } else {
    logger.info("optimise alone cleared the ceiling — skipping collect");
  }

  const freedBytes = optimise.bytesFreed + (gc?.bytesFreed ?? 0) + cacheFreed;
  appendSweepLog(opts, freedBytes, gc);
  const runLogs = pruneFlightRecorderLogs(opts, logger);
  return {
    swept: true,
    reason: before.reason,
    storeBytes,
    freedBytes,
    runLogs,
    optimise,
    ...(gc !== undefined ? { gc } : {}),
  };
}

/** Best-effort orphan-scratch reap — wraps the reaper so a failure can never break the sweep. */
function reapScratchOrphans(opts: AutoGcOptions, logger: Logger): void {
  try {
    sweepOrphanedScratch({
      tmpDir: opts.scratchTmpDir ?? tmpdir(),
      now: opts.now,
      ...(opts.scratchMaxAgeMs !== undefined ? { maxAgeMs: opts.scratchMaxAgeMs } : {}),
      logger,
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "scratch-orphan reap failed (best-effort)");
  }
}

function pruneFlightRecorderLogs(opts: AutoGcOptions, logger: Logger): PruneRunLogsReport {
  try {
    return pruneRunLogs({
      runsDir: opts.runLogDir ?? join(opts.dir, "runs"),
      logger,
      ...(opts.runLogCeilingBytes !== undefined ? { ceilingBytes: opts.runLogCeilingBytes } : {}),
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "flight-recorder prune failed (best-effort)");
    return { bytesBefore: 0, bytesAfter: 0, bytesFreed: 0, runsDeleted: 0 };
  }
}

/** Append the never-silent one-line "freed X" record the next run surfaces. */
function appendSweepLog(opts: AutoGcOptions, freedBytes: number, gc: GcReport | undefined): void {
  const gcLogPath = opts.gcLogPath ?? join(opts.dir, "gc.log");
  const paths = gc?.pathsDeleted ?? 0;
  appendFileSync(gcLogPath, `${opts.now()} last sweep freed ${freedBytes} bytes (${paths} path(s) collected)\n`);
}

/**
 * The last "freed X" line of the gc log, for the next run to surface at startup.
 * Degrades silently to `undefined` when the log is missing/empty (the common case
 * before the first sweep) — never throws.
 */
export function readLastSweepLine(gcLogPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(gcLogPath, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}
