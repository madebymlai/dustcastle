import { join } from "node:path";

/** The cache entry directory for one project deps fingerprint. */
export function entryDir(cacheDir: string, depsKey: string): string {
  return join(cacheDir, depsKey);
}

/** The cached/restored content path for one ecosystem's assembled stage dir. */
export function contentPath(cacheDir: string, depsKey: string, stageDir: string): string {
  return join(entryDir(cacheDir, depsKey), stageDir);
}
