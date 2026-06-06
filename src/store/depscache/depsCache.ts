import { existsSync } from "node:fs";
import type { Detection } from "../../detect/index.js";
import { ecosystemFor } from "../../ecosystems/index.js";
import { depsCacheKey } from "./depsCacheKey.js";
import { contentPath, entryDir } from "./layout.js";

const COMPLETE_MARKER = ".dustcastle-deps-cache-complete";

/**
 * The host-side deps-cache decision for ONE ecosystem (ADR 0016). The decision is
 * only the query result: the ecosystem's stable deps fingerprint plus whether that
 * fingerprint already holds a complete assembled stage dir.
 */
export interface DepsCacheDecision {
  /** The ecosystem's project deps fingerprint — every detected ecosystem is cacheable. */
  readonly depsKey: string;
  /** HIT restores and skips install; MISS installs in-Sandbox, then populates after the run. */
  readonly hit: boolean;
}

/**
 * One ecosystem's cache entry to POPULATE after the run completes. On a cache miss,
 * the host copies the worktree's assembled stage dir into the deps-key entry dir once
 * the in-Sandbox install has succeeded.
 */
export interface DepsCachePopulate {
  /** The project deps fingerprint keying this ecosystem's cache entry. */
  readonly depsKey: string;
  /** The worktree-relative stage dir the in-Sandbox install assembled (`node_modules`/`site`/`vendor`). */
  readonly stageDir: string;
}

/**
 * The host-side deps-cache hit/miss decision for one ecosystem. Every detected
 * Ecosystem produces a deps fingerprint; a hit requires both the staged content and
 * the cache-complete marker, so a crashed/partial populate self-heals as a miss.
 */
export function depsCacheDecision(projectDir: string, detection: Detection, cacheDir: string): DepsCacheDecision {
  const depsKey = depsCacheKey(projectDir, detection);
  const stageDir = ecosystemFor(detection.ecosystem).sandbox.stageDir;
  return {
    depsKey,
    hit: completeEntryExists(cacheDir, depsKey, stageDir),
  };
}

function completeEntryExists(cacheDir: string, depsKey: string, stageDir: string): boolean {
  return existsSync(contentPath(cacheDir, depsKey, stageDir)) && existsSync(completeMarker(cacheDir, depsKey));
}

/** The path inputs shared by the pure deps-cache shell command builders. */
export interface DepsCacheCommandInput extends DepsCachePopulate {
  /** The deps-cache root holding deps-keyed entry dirs. */
  readonly cacheDir: string;
}

/**
 * The worktree success sentinel for one stage dir. The install chain removes it before
 * running and touches it only after every Package Manager command succeeds; populate is
 * gated on it. It lives outside the stage dir, so it is never copied into the cached
 * or restored stage dir.
 */
export function installSuccessSentinel(stageDir: string): string {
  return `.dustcastle-deps-install-success-${stageDir.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

/** Cache-entry completeness marker, outside the restored stage dir. */
export function completeMarker(cacheDir: string, depsKey: string): string {
  return `${entryDir(cacheDir, depsKey)}/${COMPLETE_MARKER}`;
}

/**
 * The host-side deps-cache RESTORE for one ecosystem. Copies the assembled deps from
 * `<cacheDir>/<depsKey>/<stageDir>` into the worktree before the Sandbox starts and
 * touches the entry dir so the GC pool's mtime-based recency tracks actual use.
 */
export function restoreCommand(restore: DepsCacheCommandInput): string {
  const cacheEntryDir = entryDir(restore.cacheDir, restore.depsKey);
  const src = contentPath(restore.cacheDir, restore.depsKey, restore.stageDir);
  const marker = completeMarker(restore.cacheDir, restore.depsKey);
  const sentinel = installSuccessSentinel(restore.stageDir);
  const stageDir = restore.stageDir;
  const restoreSteps = shellAnd([
    `rm -f ${shellQuote(sentinel)}`,
    `rm -rf ${shellQuote(stageDir)}`,
    `cp -a ${shellQuote(src)} ${shellQuote(stageDir)}`,
    `chmod -R u+rwX ${shellQuote(stageDir)}`,
    `touch ${shellQuote(cacheEntryDir)}`,
  ]);

  return `if [ -f ${shellQuote(marker)} ] && [ -d ${shellQuote(src)} ]; then ${restoreSteps}; fi`;
}

/**
 * The host-side command that POPULATES one ecosystem's cache entry after the run.
 * The copy is gated on the install success sentinel and uses an atomic temp dir +
 * cache-complete marker, so failed installs or interrupted copies do not become hits.
 */
export function populateCommand(populate: DepsCacheCommandInput): string {
  const cacheEntryDir = entryDir(populate.cacheDir, populate.depsKey);
  const dest = contentPath(populate.cacheDir, populate.depsKey, populate.stageDir);
  const tmp = `${dest}.tmp`;
  const marker = completeMarker(populate.cacheDir, populate.depsKey);
  const sentinel = installSuccessSentinel(populate.stageDir);
  const stageDir = populate.stageDir;
  const populateSteps = shellAnd([
    `mkdir -p ${shellQuote(cacheEntryDir)}`,
    `rm -f ${shellQuote(marker)}`,
    `rm -rf ${shellQuote(tmp)}`,
    `cp -a ${shellQuote(stageDir)} ${shellQuote(tmp)}`,
    `rm -rf ${shellQuote(dest)}`,
    `mv ${shellQuote(tmp)} ${shellQuote(dest)}`,
    `touch ${shellQuote(marker)}`,
  ]);

  return `if [ -f ${shellQuote(sentinel)} ] && [ -d ${shellQuote(stageDir)} ]; then ${populateSteps}; fi`;
}

function shellAnd(commands: readonly string[]): string {
  return commands.join(" && ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
