import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { noopLogger, type Logger } from "../log/index.js";
import {
  addRootArgs,
  nixPortableRunner,
  type NixRunner,
} from "./nix.js";

/**
 * The GC-root lifecycle (ADR 0007): scoped (per-run, released on completion) and
 * recency (persistent, pruned by byte-budget) roots over a shared private mechanism
 * (`addClosureRoots`). Nix never garbage-collects by default, so dustcastle owns
 * both lifecycles — each register through the nix port (`nix.ts`). The scoped root
 * pins a live run's Toolchain closure so a concurrent `nix-store --gc` never
 * collects it; the recency root keeps a just-used closure warm across runs and is
 * pruned only when the project falls outside the byte-budget tail.
 *
 * The two lifecycles are genuinely different in release: scoped roots release as a
 * unit (the returned handle), recency roots are pruned by keep-set (the warm keys
 * survive, the rest are removed). They share one private `addClosureRoots` — the
 * mechanism is the same; only the lifecycle around it differs. No `roots(kind)`
 * factory (that would unify at the directory axis and leak a discriminated-union
 * handle for two genuinely-different contracts).
 */

/** A store path a provision realizes, tagged by its role in the closure. */
export interface RootPath {
  readonly kind: "toolchain";
  readonly path: string;
}

/**
 * Which paths a provision pins as GC roots (ADR 0007/0012): the Store realizes only
 * the Toolchain, so each provision contributes exactly one toolchain root.
 */
export function rootStorePaths(provisioned: { readonly toolchainStorePath: string }): RootPath[] {
  return [{ kind: "toolchain", path: provisioned.toolchainStorePath }];
}

/** Sanitize a project key (a hash with `/`, `+`, `=`) into one filesystem-safe name. */
function sanitizeKey(projectKey: string): string {
  return projectKey.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * The GC-root link path for a project's closure path, keyed by project key + kind.
 * The key is sanitized so it is a single filesystem-safe link name. Used for both
 * the scoped (in-flight) roots and the persistent recency roots, each in their own
 * dir.
 */
export function gcRootLink(gcrootsDir: string, projectKey: string, kind: RootPath["kind"]): string {
  return join(gcrootsDir, `${sanitizeKey(projectKey)}-${kind}`);
}

/** A handle to a run's scoped GC roots: where they live, and how to release them. */
export interface ScopedRootsHandle {
  /** The link paths registered (one per rooted closure path). */
  readonly links: string[];
  /** Remove the scoped roots, making the closure collectable once no other run roots it. */
  release(): void;
}

export interface RegisterScopedRootsOptions {
  readonly provisioned: { readonly toolchainStorePath: string };
  /** Directory the scoped-root link symlinks live in (dustcastle-owned). */
  readonly gcrootsDir: string;
  /** Identifies the Store root entry (temporary manager-toolchain key in this slice). */
  readonly projectKey: string;
  /** Inject a nix runner (tests); defaults to a real nix-portable spawn. */
  readonly run?: NixRunner;
  /** Structured progress logs. */
  readonly logger?: Logger;
}

/**
 * Register a scoped GC root for each path in a provision's closure (ADR 0007), so a
 * concurrent / in-flight `dustcastle run` is never collected out from under it.
 * Returns a handle whose `release()` drops the roots (removes the link symlinks) —
 * call it on run completion. Best-effort per root: a root that fails to register is
 * surfaced but does not abort the run (a missing root only risks a cold rebuild).
 */
export function registerScopedRoots(opts: RegisterScopedRootsOptions): ScopedRootsHandle {
  const run = opts.run ?? nixPortableRunner();
  const logger = opts.logger ?? noopLogger;
  const links = addClosureRoots({
    provisioned: opts.provisioned,
    rootsDir: opts.gcrootsDir,
    projectKey: opts.projectKey,
    run,
    logger,
  });
  return {
    links,
    release: () => {
      for (const link of links) rmSync(link, { force: true });
      logger.debug({ roots: links.length }, "released scoped roots");
    },
  };
}

export interface RegisterRecencyRootOptions {
  readonly provisioned: { readonly toolchainStorePath: string };
  /** Directory the persistent recency-root symlinks live in (separate from scoped roots). */
  readonly recencyRootsDir: string;
  /** Identifies the Store root entry — the same key as the scoped root. */
  readonly projectKey: string;
  readonly run?: NixRunner;
  readonly logger?: Logger;
}

/**
 * Register a PERSISTENT recency GC root for a project's closure (ADR 0007). Unlike
 * the scoped root (released when the run completes), this root outlives the run, so
 * a just-used Toolchain stays warm across runs — it is pruned only when the project
 * falls outside the byte-budget tail (`pruneRecencyRoots`). Returns the link paths.
 * Best-effort per root (mirrors `registerScopedRoots`).
 */
export function registerRecencyRoot(opts: RegisterRecencyRootOptions): { readonly links: string[] } {
  const run = opts.run ?? nixPortableRunner();
  const logger = opts.logger ?? noopLogger;
  const links = addClosureRoots({
    provisioned: opts.provisioned,
    rootsDir: opts.recencyRootsDir,
    projectKey: opts.projectKey,
    run,
    logger,
  });
  return { links };
}

/**
 * Prune the persistent recency roots OUTSIDE the warm byte-budget tail (ADR 0007):
 * remove every link whose project key is not in `keepKeys`, so its closure becomes
 * collectable on the next `nix-store --gc`. Keys are matched on their sanitized
 * link-name prefix (the same transform `gcRootLink` applies). Best-effort: a
 * missing dir is a no-op; a link that won't unlink is surfaced, never thrown.
 * Returns how many roots were pruned.
 */
export function pruneRecencyRoots(opts: {
  readonly recencyRootsDir: string;
  readonly keepKeys: readonly string[];
  readonly logger?: Logger;
}): { readonly pruned: number } {
  const logger = opts.logger ?? noopLogger;
  const keep = new Set(opts.keepKeys.map(sanitizeKey));
  let files: string[];
  try {
    files = readdirSync(opts.recencyRootsDir);
  } catch {
    return { pruned: 0 }; // no recency-roots dir yet → nothing to prune
  }
  let pruned = 0;
  for (const file of files) {
    const key = file.replace(/-toolchain$/, "");
    if (keep.has(key)) continue;
    try {
      rmSync(join(opts.recencyRootsDir, file), { force: true });
      pruned += 1;
    } catch (e) {
      logger.warn({ file, err: (e as Error).message }, "could not prune recency root");
    }
  }
  if (pruned > 0) logger.debug({ pruned }, "pruned recency roots outside warm budget");
  return { pruned };
}

/**
 * Add an (indirect) GC root for each path in a provision's closure under `rootsDir`,
 * keyed by `projectKey` + kind. Best-effort per root: a root that fails to register
 * is surfaced as a warn record but never aborts — a missing root only risks a cold
 * rebuild. Shared by the scoped (released on completion) and recency (persistent)
 * roots; the only difference is the directory and the lifecycle around it.
 */
function addClosureRoots(opts: {
  readonly provisioned: { readonly toolchainStorePath: string };
  readonly rootsDir: string;
  readonly projectKey: string;
  readonly run: NixRunner;
  readonly logger: Logger;
}): string[] {
  mkdirSync(opts.rootsDir, { recursive: true });
  const links: string[] = [];
  for (const root of rootStorePaths(opts.provisioned)) {
    const link = gcRootLink(opts.rootsDir, opts.projectKey, root.kind);
    const result = opts.run(addRootArgs(root.path, link));
    if (result.status === 0) {
      links.push(link);
      opts.logger.debug({ kind: root.kind, storePath: root.path, link }, "rooted store path");
    } else {
      opts.logger.warn({ kind: root.kind, storePath: root.path, stderr: result.stderr.trim() }, "could not root store path");
    }
  }
  return links;
}
