import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { overCeiling, type CeilingReason } from "./ceiling.js";
import { ensureNixPortable } from "./index.js";
import { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

/**
 * Store lifecycle management (ADR 0007). Nix never garbage-collects by default, so
 * the shared rootless /nix/store grows unbounded across provisions. dustcastle owns
 * the lifecycle with three mechanisms: (1) scoped GC roots — one per active project,
 * pinning its toolchain + deps closure so an in-flight run is never collected out
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
  readonly kind: "toolchain" | "deps";
  readonly path: string;
}

/**
 * Which paths a provision pins as GC roots (ADR 0007): its toolchain + deps
 * closure. Empties are skipped (the impure path installs deps in the container, not
 * the Store) and duplicates collapse (a JS app path equals its deps path).
 */
export function rootStorePaths(provisioned: {
  readonly toolchainStorePath: string;
  readonly depsStorePath: string;
}): RootPath[] {
  const roots: RootPath[] = [];
  const seen = new Set<string>();
  const add = (kind: RootPath["kind"], path: string): void => {
    if (path.length === 0 || seen.has(path)) return;
    seen.add(path);
    roots.push({ kind, path });
  };
  add("toolchain", provisioned.toolchainStorePath);
  add("deps", provisioned.depsStorePath);
  return roots;
}

/** A project's last-use timestamp + closure size, the input to the recency tail (ADR 0007). */
export interface RecencyRecord {
  /** The project's GC key — its `<manager>-<deps-hash>` (mirrors `gcProjectKey`). */
  readonly projectKey: string;
  /** When this project's closure was last used by a run (epoch ms). */
  readonly lastUsedAt: number;
  /** The on-disk size of this project's closure (bytes) — the byte-budget unit. */
  readonly closureBytes: number;
}

/**
 * The byte-budget LRU recency tail (ADR 0007 — "the most-recently-used closures
 * that fit a byte budget"). Walks the records newest-first and keeps each whose
 * closure still fits under `budgetBytes`, stopping at the first that overflows —
 * exactly LRU eviction (evict the oldest until the total fits). Byte-budget, not
 * count-based, because closures vary wildly in size: a count-based "keep N" is
 * size-blind and would let a few large closures blow the disk. The kept keys are
 * the closures a sweep keeps rooted (warm); the rest go cold. `budgetBytes` is the
 * low watermark (a product-derived parameter, never baked in).
 *
 * Edges: a zero budget keeps nothing; a single closure larger than the whole
 * budget is dropped (its key never fits), so the warm set stays bounded by bytes.
 */
export function recencyTailKeys(records: readonly RecencyRecord[], budgetBytes: number): string[] {
  const newestFirst = [...records].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const keep: string[] = [];
  let spent = 0;
  for (const r of newestFirst) {
    const next = spent + Math.max(0, r.closureBytes);
    if (next > budgetBytes) break; // LRU: this and every older closure go cold
    spent = next;
    keep.push(r.projectKey);
  }
  return keep;
}

/** What the policy decided: whether to sweep now (and why), and which closures to keep rooted. */
export interface GarbageCollectionPlan {
  /** Run a collect now? (The hybrid cap-OR-floor ceiling fired.) */
  readonly sweep: boolean;
  /** Which half of the hybrid ceiling fired (`"cap"`/`"floor"`/`"none"`). */
  readonly reason: CeilingReason;
  /** The project keys whose closures stay rooted through a sweep (the byte-budget tail). */
  readonly keep: string[];
}

/**
 * The pure policy brain (ADR 0007's chosen stance): "keep what active projects root
 * + a byte-budget recently-used tail; collect the rest on a disk-derived hybrid
 * ceiling." Composes the hybrid cap-OR-floor trigger (`overCeiling`) with the
 * byte-budget recency tail (`recencyTailKeys`) into one decision the imperative
 * auto-trigger consumes — measure the store + disk, read recency, then act on this.
 * Every threshold is derived from the disk the caller measures; this function bakes
 * in no number.
 */
export function garbageCollectionPlan(opts: {
  readonly storeBytes: number;
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly records: readonly RecencyRecord[];
  readonly budgetBytes: number;
}): GarbageCollectionPlan {
  const ceiling = overCeiling({
    storeBytes: opts.storeBytes,
    freeBytes: opts.freeBytes,
    totalBytes: opts.totalBytes,
  });
  return {
    sweep: ceiling.over,
    reason: ceiling.reason,
    keep: recencyTailKeys(opts.records, opts.budgetBytes),
  };
}

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
 * The GC-root link path for a project's closure path, keyed by project (the
 * lockfile hash) + kind (ADR 0007 — roots keyed by lockfile hash). The hash is
 * sanitized so it is a single filesystem-safe link name. Used for both the scoped
 * (in-flight) roots and the persistent recency roots, each in their own dir.
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
  readonly provisioned: { readonly toolchainStorePath: string; readonly depsStorePath: string };
  /** Directory the scoped-root link symlinks live in (dustcastle-owned). */
  readonly gcrootsDir: string;
  /** Identifies the project's deps state — the lockfile hash (ADR 0007). */
  readonly projectKey: string;
  /** Inject a nix runner (tests); defaults to a real nix-portable spawn. */
  readonly run?: NixRunner;
  /** Surface progress (never silent — ADR 0007). */
  readonly onLine?: (line: string) => void;
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
  const log = opts.onLine ?? (() => {});
  const links = addClosureRoots({
    provisioned: opts.provisioned,
    rootsDir: opts.gcrootsDir,
    projectKey: opts.projectKey,
    run,
    log,
  });
  return {
    links,
    release: () => {
      for (const link of links) rmSync(link, { force: true });
      log(`gc: released ${links.length} scoped root(s)`);
    },
  };
}

/**
 * Add an (indirect) GC root for each path in a provision's closure under `rootsDir`,
 * keyed by `projectKey` + kind. Best-effort per root: a root that fails to register
 * is surfaced (a WARNING) but never aborts — a missing root only risks a cold
 * rebuild. Shared by the scoped (released on completion) and recency (persistent)
 * roots; the only difference is the directory and the lifecycle around it.
 */
function addClosureRoots(opts: {
  readonly provisioned: { readonly toolchainStorePath: string; readonly depsStorePath: string };
  readonly rootsDir: string;
  readonly projectKey: string;
  readonly run: NixRunner;
  readonly log: (line: string) => void;
}): string[] {
  mkdirSync(opts.rootsDir, { recursive: true });
  const links: string[] = [];
  for (const root of rootStorePaths(opts.provisioned)) {
    const link = gcRootLink(opts.rootsDir, opts.projectKey, root.kind);
    const result = opts.run(addRootArgs(root.path, link));
    if (result.status === 0) {
      links.push(link);
      opts.log(`gc: rooted ${root.kind} ${root.path} → ${link}`);
    } else {
      opts.log(`gc: WARNING could not root ${root.kind} ${root.path}: ${result.stderr.trim()}`);
    }
  }
  return links;
}

export interface RegisterRecencyRootOptions {
  readonly provisioned: { readonly toolchainStorePath: string; readonly depsStorePath: string };
  /** Directory the persistent recency-root symlinks live in (separate from scoped roots). */
  readonly recencyRootsDir: string;
  /** Identifies the project's deps state — the same key as the scoped root (ADR 0007). */
  readonly projectKey: string;
  readonly run?: NixRunner;
  readonly onLine?: (line: string) => void;
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
  const log = opts.onLine ?? (() => {});
  const links = addClosureRoots({
    provisioned: opts.provisioned,
    rootsDir: opts.recencyRootsDir,
    projectKey: opts.projectKey,
    run,
    log,
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
  readonly onLine?: (line: string) => void;
}): { readonly pruned: number } {
  const log = opts.onLine ?? (() => {});
  const keep = new Set(opts.keepKeys.map(sanitizeKey));
  let files: string[];
  try {
    files = readdirSync(opts.recencyRootsDir);
  } catch {
    return { pruned: 0 }; // no recency-roots dir yet → nothing to prune
  }
  let pruned = 0;
  for (const file of files) {
    const key = file.replace(/-(?:toolchain|deps)$/, "");
    if (keep.has(key)) continue;
    try {
      rmSync(join(opts.recencyRootsDir, file), { force: true });
      pruned += 1;
    } catch (e) {
      log(`gc: WARNING could not prune recency root ${file}: ${(e as Error).message}`);
    }
  }
  if (pruned > 0) log(`gc: pruned ${pruned} recency root(s) outside the warm budget`);
  return { pruned };
}

export interface CollectGarbageOptions {
  /** Inject a nix runner (tests); defaults to a real nix-portable spawn. */
  readonly run?: NixRunner;
  /** Hard-link dedup before collecting (mechanism 3). Off by default — it can be slow. */
  readonly optimise?: boolean;
  /** Surface progress (never silent — ADR 0007). */
  readonly onLine?: (line: string) => void;
}

/** The surfaced result of a lifecycle sweep. */
export interface CollectGarbageReport {
  readonly gc: GcReport;
  readonly optimise?: OptimiseReport;
}

/**
 * The policy-driven sweep (ADR 0007): optionally `nix-store --optimise` (dedup),
 * then `nix-store --gc` (delete unrooted paths — scoped-rooted closures survive).
 * Returns the surfaced reports. The live run is gated against a scratch store root.
 */
export function collectGarbage(opts: CollectGarbageOptions = {}): CollectGarbageReport {
  const run = opts.run ?? nixPortableRunner();
  const log = opts.onLine ?? (() => {});

  let optimise: OptimiseReport | undefined;
  if (opts.optimise === true) {
    const opt = run(optimiseArgs());
    optimise = parseOptimiseReport(opt.stdout + opt.stderr);
    log(`gc: optimise freed ${optimise.bytesFreed} bytes by hard-linking ${optimise.filesLinked} files`);
  }

  const gcResult = run(collectGarbageArgs());
  const gc = parseGcReport(gcResult.stdout + gcResult.stderr);
  log(`gc: collected ${gc.pathsDeleted} unrooted path(s), freed ${gc.bytesFreed} bytes`);

  return optimise !== undefined ? { gc, optimise } : { gc };
}

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
  const nixPortable = ensureNixPortable();
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
