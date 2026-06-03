import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { noopLogger, type Logger } from "../log/index.js";
import { overCeiling, type CeilingReason } from "./ceiling.js";
import { ensureNixPortableSync } from "./index.js";
import { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

/**
 * Store lifecycle management (ADR 0007). Nix never garbage-collects by default, so
 * the shared rootless /nix/store grows unbounded across provisions. dustcastle owns
 * the lifecycle with three mechanisms: (1) scoped GC roots — one per active project,
 * pinning its toolchain closure so an in-flight run is never collected out
 * from under it, released on completion; (2) `nix-store --gc` on a policy, deleting
 * only unrooted paths; (3) `nix-store --optimise`, file-level hard-link dedup.
 *
 * The pure decisions (which paths root, command construction, report parsing) are
 * here and unit-tested; the imperative orchestration runs through nix-portable (the
 * same spawn shape as `runNixBuild`) behind an injected runner, so the command
 * sequence is unit-tested and the live `nix-store --gc` is gated.
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

/**
 * NOTE: the old `garbageCollectionPlan` (the bundled "ceiling decision + keep tail")
 * was removed in ADR 0012 — the unified GC brain now composes `overCeiling` (the
 * orchestrator's ceiling decision) and `recencyTailKeys` (the warm tail, inside
 * `collectPool`) directly, over both the Store and deps-cache pools. Both pieces
 * below/in `ceiling.ts` live on; only their wrapper is gone.
 */

/** `nix-store --add-root <link> --realise <path>` — register an (indirect) GC root. */
export function addRootArgs(storePath: string, link: string): string[] {
  return ["nix-store", "--add-root", link, "--realise", storePath];
}

/** `nix-store --gc` — delete every unreachable (unrooted) store path. */
export function collectGarbageArgs(): string[] {
  return ["nix-store", "--gc"];
}

/** `nix-store --optimise` — reclaim space by hard-linking identical files. */
export function optimiseArgs(): string[] {
  return ["nix-store", "--optimise"];
}

/**
 * Non-destructive GC query (`nix-store --gc --print-{dead,live}`): list the paths a
 * sweep WOULD delete (`dead`) or keep (`live`) without deleting anything. The
 * dry-run the policy layer (and the gated e2e) uses to prove a scoped root protects
 * its closure without endangering the shared warm store.
 */
export function gcQueryArgs(which: "dead" | "live"): string[] {
  return ["nix-store", "--gc", `--print-${which}`];
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

/** What a GC sweep collected — surfaced, never silent (ADR 0007). */
export interface GcReport {
  readonly pathsDeleted: number;
  readonly bytesFreed: number;
}

/** What an optimise pass reclaimed by hard-linking. */
export interface OptimiseReport {
  readonly bytesFreed: number;
  readonly filesLinked: number;
}

/** Parse `nix-store --gc` output: a `deleting "…"` line per path + a `N bytes freed` total. */
export function parseGcReport(output: string): GcReport {
  const pathsDeleted = (output.match(/^deleting /gm) ?? []).length;
  const bytesFreed = Number(output.match(/(\d+)\s+bytes freed/)?.[1] ?? 0);
  return { pathsDeleted, bytesFreed };
}

/** Parse `nix-store --optimise` output: `N bytes (… MiB) freed by hard-linking M files`. */
export function parseOptimiseReport(output: string): OptimiseReport {
  const match = output.match(/(\d+)\s+bytes.*?freed by hard-linking\s+(\d+)\s+files/s);
  return { bytesFreed: Number(match?.[1] ?? 0), filesLinked: Number(match?.[2] ?? 0) };
}

/** The minimal result of a nix invocation the orchestration reasons about. */
export interface NixResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `nix-portable <args>`. Injected in tests; defaults to a real nix-portable spawn. */
export type NixRunner = (args: readonly string[]) => NixResult;

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
 * The pre-pool direct-drive sweep (`collectGarbage`) was removed in ADR 0012: both
 * sweep callers now cross the unified pool brain. The automatic trigger (`autogc.ts`)
 * drives `collectPool` per pool; the manual `dustcastle gc` (`cli/gc.ts`) drives
 * `collectPools` over the Store + deps-cache pools with a zero budget. The Store pool
 * (`storePool.ts`) owns the optimise → prune-cold-roots → `nix-store --gc` mechanism;
 * `collectGarbageArgs`/`optimiseArgs`/`parseGcReport`/`parseOptimiseReport` live on as
 * its building blocks.
 */

/** The dustcastle-owned scoped-root directory under the rootless store install (ADR 0007/0008). */
export function defaultGcRootsDir(): string {
  return join(homedir(), ".dustcastle", "gcroots");
}

/** The persistent recency-root directory, a sibling of the scoped roots (ADR 0007). */
export function defaultRecencyRootsDir(): string {
  return join(homedir(), ".dustcastle", "recency-roots");
}

/** A real nix-portable runner: same spawn shape as `runNixBuild` (NP_RUNTIME env). */
export function nixPortableRunner(): NixRunner {
  const nixPortable = ensureNixPortableSync();
  const mode: RuntimeMode = chooseRuntimeMode({ unprivilegedUserns: unprivilegedUsernsAvailable() });
  return (args: readonly string[]): NixResult => {
    const r = spawnSync(nixPortable, [...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NP_RUNTIME: mode },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}
