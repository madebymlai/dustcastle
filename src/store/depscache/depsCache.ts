import { existsSync } from "node:fs";
import type { Detection } from "../../detect/index.js";
import { depsCacheKey } from "./depsCacheKey.js";
import { contentPath, entryDir } from "./layout.js";

/**
 * The host-side deps-cache decision for ONE ecosystem (ADR 0012, dustcastle-8od).
 * The decision is only the query result: the ecosystem's stable cache key plus
 * whether that key is already present. The cache root is run-level configuration
 * supplied once to the Sandbox plan / command builders, not repeated here.
 */
export interface DepsCacheDecision {
  /**
   * The ecosystem's lockfile hash — the cache key. Undefined for a loose / no-lockfile
   * ecosystem, which has no stable key, so it is never cached (always installs in-Sandbox).
   */
  readonly lockfileHash: string | undefined;
  /**
   * Whether the cache holds an assembled entry for this lockfile hash. A HIT restores
   * via `host.onWorktreeReady` and runs no install; a MISS installs in-Sandbox, then
   * populates the cache entry after the run.
   */
  readonly hit: boolean;
}

/**
 * One ecosystem's cache entry to POPULATE after the run completes (ADR 0012). On a
 * cache miss, the host copies the worktree's assembled stage dir into the lockfile-hash
 * entry dir once the in-Sandbox install has run. The cache root is supplied once by
 * the run-level caller and combined with this descriptor by the cache module's layout owner.
 */
export interface DepsCachePopulate {
  /** The lockfile hash keying this ecosystem's cache entry. */
  readonly lockfileHash: string;
  /** The worktree-relative stage dir the in-Sandbox install assembled (`node_modules`/`site`/`vendor`). */
  readonly stageDir: string;
}

/**
 * The host-side deps-cache hit/miss decision for one ecosystem (ADR 0012,
 * dustcastle-8od). dustcastle owns the cache (under the dustcastle home) and decides
 * per ecosystem, keyed by that ecosystem's lockfile hash:
 *   - a lockfile present + an assembled entry on disk for its hash ⇒ HIT (the plan
 *     restores via `host.onWorktreeReady`, no install / no registry traffic);
 *   - a lockfile present + no entry yet ⇒ MISS (the plan installs in-Sandbox, then
 *     the entry is populated after the run);
 *   - a loose / no-lockfile ecosystem ⇒ no stable key ⇒ NOT cached (`undefined`), so
 *     it always installs in-Sandbox.
 *
 * Returns `undefined` for the uncacheable case so the plan falls through to "install,
 * don't cache"; otherwise the {@link DepsCacheDecision} the plan emits hooks from.
 */
export function depsCacheDecision(
  projectDir: string,
  detection: Detection,
  cacheDir: string,
): DepsCacheDecision | undefined {
  const lockfileHash = depsCacheKey(projectDir, detection);
  if (lockfileHash === undefined) return undefined; // loose / no lockfile → never cached
  return {
    lockfileHash,
    hit: existsSync(entryDir(cacheDir, lockfileHash)),
  };
}

/** The path inputs shared by the pure deps-cache shell command builders. */
export interface DepsCacheCommandInput extends DepsCachePopulate {
  /** The deps-cache root holding lockfile-hash-keyed entry dirs. */
  readonly cacheDir: string;
}

/**
 * The host-side deps-cache RESTORE for one ecosystem (ADR 0012, dustcastle-8od).
 * Copies the assembled deps from `<cacheDir>/<lockfileHash>/<stageDir>` into the
 * worktree's `<stageDir>` before the Sandbox starts. On a hit it also touches the
 * entry dir so the GC pool's mtime-based recency tracks actual use.
 */
export function restoreCommand(restore: DepsCacheCommandInput): string {
  const cacheEntryDir = entryDir(restore.cacheDir, restore.lockfileHash);
  const src = contentPath(restore.cacheDir, restore.lockfileHash, restore.stageDir);
  return (
    `if [ -d '${src}' ]; then ` +
    `rm -rf '${restore.stageDir}' && cp -RL '${src}' '${restore.stageDir}' && chmod -R u+rwX '${restore.stageDir}' && touch '${cacheEntryDir}'; ` +
    `fi`
  );
}

/**
 * The host-side command that POPULATES one ecosystem's cache entry after the run
 * (ADR 0012): copy the worktree's assembled stage dir into its lockfile-hash entry,
 * dereferencing symlinks (`cp -RL`, the same shape the restore uses). Guarded on the
 * stage dir existing (a failed install leaves nothing to cache) and idempotent (it
 * replaces any partial prior entry), so re-running is safe. Runs after `run()` returns
 * — the unambiguous timing, since sandcastle runs `host.onSandboxReady` concurrently
 * with the in-Sandbox install, not after it.
 */
export function populateCommand(populate: DepsCacheCommandInput): string {
  const cacheEntryDir = entryDir(populate.cacheDir, populate.lockfileHash);
  const dest = contentPath(populate.cacheDir, populate.lockfileHash, populate.stageDir);
  return (
    `if [ -d '${populate.stageDir}' ]; then ` +
    `mkdir -p '${cacheEntryDir}' && rm -rf '${dest}' && cp -RL '${populate.stageDir}' '${dest}'; ` +
    `fi`
  );
}
