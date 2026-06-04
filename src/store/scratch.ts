import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, type Logger } from "../log/index.js";

/**
 * The `mkdtemp` prefixes for dustcastle's throwaway scratch dirs — the single source of
 * truth shared by the creators (`withTempDir` call sites) and the orphan reaper
 * (`sweepOrphanedScratch`). `provisionStore` stages a project's committed tree under a
 * BUILD dir; `archiveCommittedTree` writes its `git archive` tarball under an ARCHIVE
 * dir. Both are reclaimed in-process on success/failure; the reaper is the backstop for
 * crash-leaks (SIGKILL/OOM) where no `finally` can run.
 */
export const BUILD_SCRATCH_PREFIX = "dustcastle-build-";
export const ARCHIVE_SCRATCH_PREFIX = "dustcastle-archive-";

/**
 * Run `fn` against a fresh `mkdtemp` dir under the OS temp dir, then remove the dir —
 * pairing creation with cleanup in one place so no caller can leak a scratch tree.
 *
 * The hidden depth is the sync/async cleanup timing that the original `provisionStore`
 * leak got wrong: when `fn` returns a promise, removing the dir in a plain `finally`
 * fires while the build is still reading it. So a thenable result defers cleanup to
 * `.finally()` (after it settles); a sync result is cleaned immediately. Either way a
 * throw/rejection still removes the dir and propagates.
 */
export function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T>;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T;
export function withTempDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): T | Promise<T> {
  // Embed the owner PID (`<prefix><pid>-<rand>`) so a later sweep can ask "is the process
  // that made this still alive?" instead of guessing from the dir's age.
  const dir = mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result: T | Promise<T>;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result instanceof Promise) return result.finally(cleanup);
  cleanup();
  return result;
}

/** PID-reuse backstop: an owner that still *looks* alive but whose dir is older than this
 * is treated as a stale collision and reaped. Days-scale — far longer than any real
 * provisioning build — so a genuinely live build is never caught by it. */
export const DEFAULT_SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SCRATCH_PREFIXES = [BUILD_SCRATCH_PREFIX, ARCHIVE_SCRATCH_PREFIX] as const;

export interface SweepOrphanedScratchOptions {
  /** The dir holding scratch entries (production: the OS temp dir). */
  readonly tmpDir: string;
  /** The wall clock (epoch ms), injected so the PID-reuse backstop is deterministic in tests. */
  readonly now: () => number;
  /** The PID-reuse backstop age (default 7d). */
  readonly maxAgeMs?: number;
  /**
   * Whether the process that created a scratch dir is still a live owner. Injected in
   * tests; production uses {@link defaultOwnerAlive} (`kill(pid,0)` + `/proc` identity).
   */
  readonly isOwnerAlive?: (pid: number) => boolean;
  /** Structured progress logs. */
  readonly logger?: Logger;
}

export interface SweepOrphanedScratchReport {
  readonly dirsDeleted: number;
  readonly bytesFreed: number;
}

/**
 * Reap dustcastle scratch dirs (`withTempDir`'s build/archive trees) a crash left
 * behind — the SIGKILL/OOM path where the in-process cleanup can't run. Liveness, not
 * age, is the signal: each dir carries its owner PID (`<prefix><pid>-<rand>`), and a
 * dir is an orphan when that owner is not a live same-kind process — so a crash-orphan
 * is reclaimed on the next pass while a concurrent live build is never touched, however
 * long it runs. A dir with no parseable owner (old-format/corrupt) can have no live
 * owner, so it is reaped too. Best-effort: any per-entry error is logged and skipped,
 * never thrown.
 */
export function sweepOrphanedScratch(opts: SweepOrphanedScratchOptions): SweepOrphanedScratchReport {
  const logger = opts.logger ?? noopLogger;
  const isOwnerAlive = opts.isOwnerAlive ?? defaultOwnerAlive;
  const cutoff = opts.now() - (opts.maxAgeMs ?? DEFAULT_SCRATCH_MAX_AGE_MS);

  let dirsDeleted = 0;
  let bytesFreed = 0;
  for (const name of listScratchNames(opts.tmpDir)) {
    const path = join(opts.tmpDir, name);
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      if (!stat.isDirectory()) continue; // a file sharing the prefix → not ours
      mtimeMs = stat.mtimeMs;
    } catch {
      continue; // vanished between readdir and stat → nothing to reap
    }
    // A live owner within the reuse backstop is left alone; an alive-looking owner whose
    // dir has aged past the backstop is a stale PID-reuse collision, so it is reaped.
    const pid = parseOwnerPid(name);
    const liveOwner = pid !== undefined && isOwnerAlive(pid) && mtimeMs > cutoff;
    if (liveOwner) continue;
    const bytes = dirBytes(path);
    try {
      rmSync(path, { recursive: true, force: true });
      dirsDeleted += 1;
      bytesFreed += bytes;
    } catch (e) {
      logger.warn({ path, err: (e as Error).message }, "could not reap orphaned scratch dir (best-effort)");
    }
  }
  if (dirsDeleted > 0) logger.info({ dirsDeleted, bytesFreed }, "reaped orphaned scratch dirs");
  return { dirsDeleted, bytesFreed };
}

/** The owner PID encoded in a `<prefix><pid>-<rand>` scratch name, or undefined when the
 * name has no `<pid>-` segment (an old-format or corrupt dir — no owner to attribute). */
function parseOwnerPid(name: string): number | undefined {
  const prefix = SCRATCH_PREFIXES.find((p) => name.startsWith(p));
  if (prefix === undefined) return undefined;
  const rest = name.slice(prefix.length); // "<pid>-<rand>"
  const dash = rest.indexOf("-");
  if (dash <= 0) return undefined;
  const digits = rest.slice(0, dash);
  return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/**
 * Whether `pid` is a still-live dustcastle owner. `kill(pid, 0)` answers "does a
 * signalable process with this PID exist?" — ESRCH (gone) or EPERM (the PID now belongs
 * to another user) both mean our original owner is dead. A signalable PID could still be
 * a *reused* same-user PID, so we confirm identity by matching `/proc/<pid>/comm` to our
 * own (a live dustcastle run shares the reaper's process kind). When `/proc` is
 * unreadable (non-Linux), we trust the kill-liveness alone — the age backstop covers the
 * residual reuse case.
 */
function defaultOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // ESRCH / EPERM → not our live owner
  }
  const self = readComm(process.pid);
  const other = readComm(pid);
  if (self === undefined || other === undefined) return true;
  return self === other;
}

/** The process command name from `/proc/<pid>/comm`, or undefined when unreadable. */
function readComm(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The resident size (bytes) of a dir tree; best-effort — an unreadable path
 * contributes 0 rather than throwing, so a measurement glitch never breaks the sweep. */
function dirBytes(path: string): number {
  let total = 0;
  let kids: import("node:fs").Dirent[];
  try {
    kids = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const kid of kids) {
    const child = join(path, kid.name);
    if (kid.isDirectory()) {
      total += dirBytes(child);
    } else {
      try {
        total += statSync(child).size;
      } catch {
        /* unreadable → 0 */
      }
    }
  }
  return total;
}

function listScratchNames(tmpDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(tmpDir);
  } catch {
    return []; // no temp dir to scan → nothing to reap (degrade, never throw)
  }
  return names.filter((name) => SCRATCH_PREFIXES.some((prefix) => name.startsWith(prefix)));
}
