import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { overCeiling, recencyBudgetBytes, type CeilingReason, type NixRunner } from "./ceiling.js";
import {
  collectGarbageArgs,
  garbageCollectionPlan,
  optimiseArgs,
  parseGcReport,
  parseOptimiseReport,
  pruneRecencyRoots,
  type GcReport,
  type OptimiseReport,
} from "./gc.js";
import { loadRecency } from "./recency.js";

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
 *   - the whole sweep is best-effort: any failure surfaces a WARNING and returns a
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
  /** Total bytes reclaimed (optimise + gc). */
  readonly freedBytes: number;
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
  /** Where the persistent recency roots live (pruned to the warm budget before collecting). */
  readonly recencyRootsDir: string;
  /** The clock (epoch ms), injected so the gc-log line is deterministic in tests. */
  readonly now: () => number;
  /** Surface progress (never silent — ADR 0007). */
  readonly onLine?: (line: string) => void;
  /** Override the lock path (defaults to `<dir>/gc.lock`). */
  readonly lockPath?: string;
  /** Override the gc-log path (defaults to `<dir>/gc.log`). */
  readonly gcLogPath?: string;
}

const NOOP: AutoGcReport = { swept: false, reason: "none", storeBytes: 0, freedBytes: 0 };

export function autoGc(opts: AutoGcOptions): AutoGcReport | "skipped" {
  const log = opts.onLine ?? (() => {});
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
      log("gc: another sweep is active — skipping");
    } else {
      log(`gc: WARNING could not acquire lock: ${(e as Error).message}`);
    }
    return "skipped";
  }

  try {
    return sweep(opts, log);
  } catch (e) {
    // Best-effort: a failed/hung sweep must never throw out of the detached child.
    log(`gc: WARNING sweep failed (best-effort, run unaffected): ${(e as Error).message}`);
    return NOOP;
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
function sweep(opts: AutoGcOptions, log: (line: string) => void): AutoGcReport {
  const storeBytes = opts.measure();
  const { free, total } = opts.disk();
  const records = loadRecency(opts.dir);
  const budgetBytes = recencyBudgetBytes({ totalBytes: total });
  const plan = garbageCollectionPlan({ storeBytes, freeBytes: free, totalBytes: total, records, budgetBytes });

  if (!plan.sweep) {
    log(`gc: store within ceiling (${storeBytes} bytes) — nothing to sweep`);
    return { swept: false, reason: plan.reason, storeBytes, freedBytes: 0 };
  }
  log(`gc: over ceiling (${plan.reason}; ${storeBytes} bytes) — sweeping`);

  // Prune the cold recency roots BEFORE collecting, so their closures become
  // collectable; the warm tail (`plan.keep`) stays rooted and survives the gc.
  pruneRecencyRoots({ recencyRootsDir: opts.recencyRootsDir, keepKeys: plan.keep, onLine: log });

  // optimise-first: the non-destructive lever (file-level hard-link dedup) that
  // cannot cause a cold rebuild. Try it before the destructive collect.
  const opt = opts.run(optimiseArgs());
  const optimise = parseOptimiseReport(opt.stdout + opt.stderr);
  log(`gc: optimise freed ${optimise.bytesFreed} bytes by hard-linking ${optimise.filesLinked} files`);

  // Re-check against fresh readings — optimise frees disk space (the floor half)
  // even though it leaves the logical store size (the cap half) unchanged.
  const after = opts.disk();
  const still = overCeiling({ storeBytes: opts.measure(), freeBytes: after.free, totalBytes: after.total });

  let gc: GcReport | undefined;
  if (still.over) {
    const gcRes = opts.run(collectGarbageArgs());
    gc = parseGcReport(gcRes.stdout + gcRes.stderr);
    log(`gc: collected ${gc.pathsDeleted} unrooted path(s), freed ${gc.bytesFreed} bytes`);
  } else {
    log("gc: optimise alone cleared the ceiling — skipping collect");
  }

  const freedBytes = optimise.bytesFreed + (gc?.bytesFreed ?? 0);
  appendSweepLog(opts, freedBytes, gc);
  return { swept: true, reason: plan.reason, storeBytes, freedBytes, optimise, ...(gc !== undefined ? { gc } : {}) };
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
