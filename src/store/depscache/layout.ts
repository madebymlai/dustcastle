import { join } from "node:path";

/** The opaque pool entry directory for one lockfile-hash-keyed deps-cache entry. */
export function entryDir(cacheDir: string, lockfileHash: string): string {
  return join(cacheDir, lockfileHash);
}

/** The run-facing path to one ecosystem's assembled deps within a cache entry. */
export function contentPath(cacheDir: string, lockfileHash: string, stageDir: string): string {
  return join(entryDir(cacheDir, lockfileHash), stageDir);
}
