import { existsSync } from "node:fs";
import type { Detection } from "../detect/index.js";
import type { DepsCacheDecision, DepsCachePopulate } from "../sandbox/plan.js";
import { depsCacheKey } from "./depsCacheKey.js";
import { depsCacheEntryDir } from "./depsCachePool.js";

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
    hit: existsSync(depsCacheEntryDir(cacheDir, lockfileHash)),
    cacheDir,
  };
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
export function populateCacheCommand(populate: DepsCachePopulate): string {
  const dest = `${populate.cacheEntryDir}/${populate.stageDir}`;
  return (
    `if [ -d '${populate.stageDir}' ]; then ` +
    `mkdir -p '${populate.cacheEntryDir}' && rm -rf '${dest}' && cp -RL '${populate.stageDir}' '${dest}'; ` +
    `fi`
  );
}
