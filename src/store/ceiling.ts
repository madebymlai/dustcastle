import { statfsSync } from "node:fs";
import type { NixRunner } from "./nix.js";

/**
 * The disk-derived hybrid ceiling (ADR 0007). Nix never garbage-collects by
 * default; dustcastle decides WHEN the shared Store is too big by deriving every
 * threshold from the actual filesystem — no absolute number is baked in (it would
 * be wrong on both a 256 GB laptop and a 4 TB workstation).
 *
 * Following the universal high/low-watermark pattern (kubelet image GC 85→80 %,
 * Nix's own `min-free`→`max-free`, Linux page reclaim): the **cap** is the high
 * watermark that *triggers* a sweep and the recency byte budget is the **low**
 * watermark we *land at* — collecting past the trigger to a strictly lower floor so
 * GC cannot thrash at the boundary. A sweep fires when EITHER the Store exceeds the
 * size cap OR free space drops below the floor — whichever bites first.
 *
 * The derivation (`storeCapBytes` / `minFreeBytes` / `recencyBudgetBytes`) is pure
 * — it takes the disk total, never calls statfs or nix — so it is unit-tested
 * without a real disk; the size accounting it consumes is injected (`measureStoreBytes`
 * / `diskSpace`).
 */


// Lean defaults: keep the Store a small, disk-scaled slice — never hog disk. On a
// 500 GB disk the Store triggers a sweep at ~50 GB and collects down to ~35 GB warm
// (the classic "50 GB /nix/store" as the ceiling, not the steady state); on a 4 TB
// box the same fractions let it grow generously (ADR 0007 story 8). The free-space
// FLOOR is the independent disk-full backstop — it fires on low free space whatever
// the Store size, including pressure from other apps (story 9).
/** Fraction of the disk the Store may fill before a sweep triggers (HIGH watermark). */
const STORE_CAP_FRACTION = 0.1;
/** Fraction of the disk the warm set is allowed to keep (LOW watermark / land-at). */
const WARM_BUDGET_FRACTION = 0.07;
/** Fraction of the disk that must stay free; a sweep fires if free drops below it. */
const MIN_FREE_FRACTION = 0.1;

/** The high watermark: the store size that triggers a sweep, derived from the disk. */
export function storeCapBytes(disk: { readonly totalBytes: number }): number {
  return Math.floor(disk.totalBytes * STORE_CAP_FRACTION);
}

/**
 * The low watermark: the byte budget the warm (recency) set must fit, derived from
 * the disk. Strictly below `storeCapBytes` (the hysteresis gap), so a sweep that
 * collects down to this budget leaves the store below the trigger cap.
 */
export function recencyBudgetBytes(disk: { readonly totalBytes: number }): number {
  return Math.floor(disk.totalBytes * WARM_BUDGET_FRACTION);
}

/** The free-space floor: a sweep fires when free disk drops to/below this. */
export function minFreeBytes(disk: { readonly totalBytes: number }): number {
  return Math.floor(disk.totalBytes * MIN_FREE_FRACTION);
}

/** Why a sweep is (or is not) due — surfaced so the trigger is never silent. */
export type CeilingReason = "cap" | "floor" | "none";

/** The hybrid trigger decision: whether to sweep now, and which half bit first. */
export interface CeilingDecision {
  readonly over: boolean;
  readonly reason: CeilingReason;
}

/**
 * The hybrid cap-OR-floor trigger (ADR 0007). Fires when the Store outgrows its
 * disk-derived size cap (`reason: "cap"`) OR free space drops below the floor
 * (`reason: "floor"`) — whichever bites first; the cap takes precedence when both
 * do. Pure: every threshold derives from `totalBytes`, so the same usage decides
 * the same way on any machine.
 */
export function overCeiling(usage: {
  readonly storeBytes: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
}): CeilingDecision {
  if (usage.storeBytes >= storeCapBytes({ totalBytes: usage.totalBytes })) {
    return { over: true, reason: "cap" };
  }
  if (usage.freeBytes <= minFreeBytes({ totalBytes: usage.totalBytes })) {
    return { over: true, reason: "floor" };
  }
  return { over: false, reason: "none" };
}

/**
 * The Store's size, via nix's own size accounting (`nix path-info --all --json`,
 * summing each path's `narSize`) — NOT a `du` walk, which would crawl the whole
 * filesystem on every post-run sweep (the cost the detached one-shot must avoid).
 * Best-effort: any failure (non-zero exit, unparseable output) degrades to 0, so a
 * measurement glitch never triggers a spurious sweep and never breaks a run.
 */
export function measureStoreBytes(run: NixRunner): number {
  try {
    const r = run(["nix", "--extra-experimental-features", "nix-command", "path-info", "--all", "--json"]);
    if (r.status !== 0) return 0;
    const parsed: unknown = JSON.parse(r.stdout);
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? Object.values(parsed)
        : [];
    let total = 0;
    for (const entry of entries) {
      const narSize = (entry as { narSize?: unknown }).narSize;
      if (typeof narSize === "number" && Number.isFinite(narSize)) total += narSize;
    }
    return total;
  } catch {
    return 0;
  }
}

/** Free / total bytes on the filesystem holding `path` (statfs — the cheap floor half). */
export function diskSpace(path: string): { readonly free: number; readonly total: number } {
  const fs = statfsSync(path);
  return { free: fs.bsize * fs.bavail, total: fs.bsize * fs.blocks };
}

/**
 * The closure size (bytes) of one store path — what a project keeps warm, the unit
 * the byte-budget recency tail bounds. Via `nix path-info -S` (closure size), not a
 * du walk. Best-effort: any failure degrades to 0 (the record is still written and
 * self-heals on the next run), so a measurement glitch never breaks a run.
 */
export function closureSizeBytes(run: NixRunner, storePath: string): number {
  try {
    const r = run(["nix", "--extra-experimental-features", "nix-command", "path-info", "-S", "--json", storePath]);
    if (r.status !== 0) return 0;
    const parsed: unknown = JSON.parse(r.stdout);
    const entry = (Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]) as
      | { closureSize?: unknown }
      | undefined;
    const size = entry?.closureSize;
    return typeof size === "number" && Number.isFinite(size) ? size : 0;
  } catch {
    return 0;
  }
}
