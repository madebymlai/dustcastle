import { readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolEntry, PoolEvictReport } from "../pool.js";

/**
 * The deps-cache pool (ADR 0012, dustcastle-8od) — the SECOND pool behind the reusable
 * GC interface (`pool.ts`). Where the Store pool's mechanism is `nix-store --gc` over
 * the shared /nix/store, this pool's mechanism is plain **lockfile-hash-keyed
 * directories** under the dustcastle home: one entry per ecosystem, keyed by that
 * ecosystem's lockfile hash, holding its assembled Project Deps (the stage dir an
 * in-Sandbox install produced — `node_modules`/`site`/`vendor`). It maps the interface
 * onto the filesystem:
 *   - `measure`  → the total resident size of every entry dir;
 *   - `entries`  → one record per `<cacheDir>/<hash>` dir (its size + mtime as recency);
 *   - `pin`/`release` → an in-memory set (a live run pins ALL its deps-cache entries);
 *   - `evict`    → remove the cold hash dirs (a pinned entry is never removed);
 *   - `optimise` → ABSENT — there is no file-level dedup across lockfiles (out of
 *     scope; the cache keys whole assembled-dep sets, not nix-style hard-linking).
 *
 * The pure brain (`collectPool`) drives it exactly as it drives the Store pool, so one
 * recency/ceiling brain manages both pools.
 */

/** The default deps-cache root under the dustcastle home (a sibling of recency.json). */
export function defaultDepsCacheDir(): string {
  return join(homedir(), ".dustcastle", "deps-cache");
}

/** The on-disk directory holding one ecosystem's assembled deps, keyed by its lockfile hash. */
export function depsCacheEntryDir(cacheDir: string, lockfileHash: string): string {
  return join(cacheDir, lockfileHash);
}

export interface DepsCachePoolOptions {
  /** The deps-cache root holding the lockfile-hash-keyed entry dirs. */
  readonly cacheDir: string;
  /**
   * Override an entry's last-used timestamp (epoch ms) by key — injected in tests so
   * the recency tail is deterministic. Production omits it and falls back to the entry
   * dir's mtime (the install/restore touches it), which is the LRU order on disk.
   */
  readonly lastUsedAt?: Readonly<Record<string, number>>;
  /** Surface progress (never silent — ADR 0007/0012). */
  readonly onLine?: (line: string) => void;
}

/** Construct the deps-cache pool over lockfile-hash-keyed directories (ADR 0012). */
export function depsCachePool(opts: DepsCachePoolOptions): Pool {
  const log = opts.onLine ?? (() => {});
  // A live run pins ALL its deps-cache entries; a pinned key is never evicted.
  const pinned = new Set<string>();

  const listHashDirs = (): string[] => {
    try {
      return readdirSync(opts.cacheDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return []; // no cache dir yet → no entries (degrade, never throw)
    }
  };

  return {
    measure: (): number => listHashDirs().reduce((sum, hash) => sum + dirBytes(depsCacheEntryDir(opts.cacheDir, hash)), 0),

    entries: (): PoolEntry[] =>
      listHashDirs().map((hash) => {
        const dir = depsCacheEntryDir(opts.cacheDir, hash);
        return {
          key: hash,
          lastUsedAt: opts.lastUsedAt?.[hash] ?? dirMtime(dir),
          bytes: dirBytes(dir),
        };
      }),

    pin: (key: string): void => {
      pinned.add(key);
    },

    release: (key: string): void => {
      pinned.delete(key);
    },

    evict: (keys: readonly string[]): PoolEvictReport => {
      let entriesEvicted = 0;
      let bytesFreed = 0;
      for (const key of keys) {
        if (pinned.has(key)) continue; // a live run's entry is never evicted
        const dir = depsCacheEntryDir(opts.cacheDir, key);
        const bytes = dirBytes(dir);
        if (bytes === 0 && !dirExists(dir)) continue; // already gone
        try {
          rmSync(dir, { recursive: true, force: true });
          entriesEvicted += 1;
          bytesFreed += bytes;
        } catch (e) {
          log(`gc: WARNING could not evict deps-cache entry ${key}: ${(e as Error).message}`);
        }
      }
      log(`gc: deps-cache evicted ${entriesEvicted} cold entry(ies), freed ${bytesFreed} bytes`);
      return { entriesEvicted, bytesFreed };
    },
    // No `optimise`: the deps cache keys whole assembled-dep sets by lockfile hash;
    // cross-lockfile file-level dedup is explicitly out of scope (ADR 0012).
  };
}

/** Whether a path exists (a directory we may have already removed). */
function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The mtime (epoch ms) of an entry dir — the LRU order on disk; 0 when unreadable. */
function dirMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The resident size (bytes) of a directory tree — the byte-budget unit, summed by a
 * recursive walk (no `du` shell-out, mirroring the cheap accounting the Store pool
 * uses). Best-effort: any unreadable path contributes 0 rather than throwing, so a
 * measurement glitch never breaks a sweep.
 */
function dirBytes(path: string): number {
  let total = 0;
  let kids: import("node:fs").Dirent[];
  try {
    kids = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const kid of kids) {
    const child = join(path, String(kid.name));
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
