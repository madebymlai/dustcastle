import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { detect, type Detection } from "../detect/index.js";
import { detectWorkspace } from "../detect/workspace.js";
import { planSandbox, type EcosystemPlan, type EcosystemPlans, type SandboxPlan } from "../sandbox/plan.js";
import { AGENT_SPEC, ensureImage } from "../sandbox/image.js";
import { provisionStore } from "../store/index.js";
import { nixPortableRunner } from "../store/nix.js";
import { storePool, type StorePoolOptions } from "../store/storePool.js";
import type { Pool } from "../store/pool.js";
import { storeClosures } from "./storeClosures.js";
import {
  depsCacheDecision,
  populateCommand,
  defaultDepsCacheDir,
  depsCachePool,
  type DepsCachePopulate,
} from "../store/depscache/index.js";
import { spawnAutoGc } from "../cli/autogc.js";
import { noopLogger, type Logger } from "../log/index.js";
import { agentAuthMounts, DUSTCASTLE_HOME } from "../config/global.js";
import { runStreamingAsync, type StreamingLogLevel } from "../process/streaming.js";

export { gcProjectKey, storeClosures, type GcProjectKeyInput } from "./storeClosures.js";

export interface PrepareOptions {
  /** The project directory to run in (defaults to the process cwd at the CLI). */
  readonly cwd: string;
  /** Override the nix-portable binary path; defaults to the dustcastle-owned copy. */
  readonly nixPortable?: string;
  /** Override the physical rootless store root. */
  readonly physStoreRoot?: string;
  /** Structured logs for provisioning subsystems. */
  readonly logger?: Logger;
  /**
   * Override the deps-cache root (ADR 0016). Tests/e2e inject a scratch dir;
   * production defaults to `~/.dustcastle/deps-cache`. The assembled Project Deps
   * are cached here, one entry per ecosystem keyed by its deps fingerprint.
   */
  readonly depsCacheDir?: string;
}

/** The deterministic result of dustcastle's pipeline: detect → provision → plan. */
export interface PreparedRun {
  /**
   * Every detected Ecosystem paired with its provisioned Toolchain (ADR 0012). A
   * polyglot repo has more than one; each installs its deps in-Sandbox.
   */
  readonly ecosystems: EcosystemPlans;
  readonly plan: SandboxPlan;
}

type NonEmptyArray<T> = readonly [T, ...T[]];

function assertNonEmpty<T>(items: readonly T[], message: string): asserts items is NonEmptyArray<T> {
  if (items.length === 0) throw new Error(message);
}

async function mapNonEmptySequential<T, U>(
  items: NonEmptyArray<T>,
  map: (item: T) => Promise<U>,
): Promise<NonEmptyArray<U>> {
  const [first, ...rest] = items;
  const mappedFirst = await map(first);
  const mappedRest: U[] = [];
  for (const item of rest) mappedRest.push(await map(item));
  return [mappedFirst, ...mappedRest];
}

/**
 * The dustcastle contribution to `dustcastle run`: detect EVERY Ecosystem in the
 * directory (ADR 0006/0012 — a polyglot repo surfaces more than one), realize each
 * one's Toolchain into the shared Store (ADR 0008), and plan the Sandbox that mounts
 * the Store read-only with normal sandbox networking (ADR 0002/0020). Deps install
 * in-Sandbox via the sandcastle hook — there is no pure-vs-impure decision. Everything
 * here is dustcastle's own work — before sandcastle's flow begins.
 */
export async function prepareRun(opts: PrepareOptions): Promise<PreparedRun> {
  const detections = detect(opts.cwd);
  assertNonEmpty(detections, `no supported ecosystem detected in ${opts.cwd}`);

  // The deps-cache root (ADR 0016): the host-owned cache, one entry per ecosystem
  // keyed by its deps fingerprint.
  const cacheDir = opts.depsCacheDir ?? defaultDepsCacheDir();

  // Provision EACH detected Ecosystem's Toolchain into the shared Store (ADR 0012:
  // the Store realizes only Toolchains; deps install in-Sandbox). A polyglot repo
  // provisions every Toolchain. Decide each ecosystem's deps-cache hit/miss host-side
  // (keyed by its deps fingerprint), so the plan emits restore-vs-install per ecosystem.
  const logger = opts.logger ?? noopLogger;
  const ecosystems = await mapNonEmptySequential(detections, async (detection): Promise<EcosystemPlan> => {
    const cache = depsCacheDecision(opts.cwd, detection, cacheDir);
    const provisioned = await provisionStore({
      projectDir: opts.cwd,
      detection,
      ...(opts.nixPortable !== undefined ? { nixPortable: opts.nixPortable } : {}),
      ...(opts.physStoreRoot !== undefined ? { physStoreRoot: opts.physStoreRoot } : {}),
      logger,
    });
    return {
      detection,
      provisioned,
      cache,
    };
  });

  return {
    ecosystems,
    plan: planSandbox({
      ecosystems,
      cacheDir,
    }),
  };
}

/** One provisioned member of a workspace, paired with its directory. */
export interface PreparedMember {
  readonly dir: string;
  readonly prepared: PreparedRun;
}

/** The result of provisioning a (possibly multi-member) workspace (ADR 0006d). */
export interface PreparedWorkspace {
  readonly root: string;
  /** Whether `root` declared a workspace (vs. a single ordinary project). */
  readonly isWorkspace: boolean;
  /** Each provisioned member; a single entry when `root` is an ordinary project. */
  readonly members: PreparedMember[];
}

/**
 * Provision a workspace (ADR 0006d): enumerate the root's members and run the full
 * detect → provision → plan pipeline for EACH (consistent with per-directory
 * accumulation — a member is just another directory). Falls back to the single
 * root project when `root` declares no workspace, so callers can use this
 * uniformly. Members with no detected ecosystem (e.g. a docs-only package) are
 * skipped — there is nothing to provision.
 */
export async function prepareWorkspace(opts: PrepareOptions): Promise<PreparedWorkspace> {
  const ws = detectWorkspace(opts.cwd);
  const provisionableProjects = ws.projects.filter((project) => project.detections.length > 0);
  const members = await Promise.all(
    provisionableProjects.map(async (project) => ({
      dir: project.dir,
      prepared: await prepareRun({ ...opts, cwd: project.dir }),
    })),
  );
  return { root: ws.root, isWorkspace: ws.isWorkspace, members };
}

/** Everything sandcastle.run() needs except the sandbox — that's dustcastle's job. */
export type SandcastleHandoff = Omit<Parameters<typeof sandcastle.run>[0], "sandbox">;

/**
 * Everything `withProvisionedSandbox` needs to provision the Store and pin the GC
 * roots — i.e. a run minus the agent handoff.
 */
export type ProvisionStorePoolOptions = Pick<StorePoolOptions, "closures" | "logger">;
export type StorePoolFactory = (opts: ProvisionStorePoolOptions) => Pool;

export interface ProvisionOptions extends PrepareOptions {
  /**
   * Called once after the Store is provisioned — the single point where the CLI
   * prints its "provisioned …" posture banner. Routing the banner through here
   * (rather than a standalone pre-run `prepareRun`) keeps the run to ONE provision.
   */
  readonly onPrepared?: (prepared: PreparedRun) => void;
  /**
   * Inject the Store pool at the sole Store-mechanism seam (ADR 0012/0015). Production
   * defaults to the real Store pool; tests that need alternate runners, root
   * directories, spawn behavior, or a no-op GC replace the whole pool here. The GC
   * mechanism itself is tested at the pool layer (`storePool.test.ts`).
   */
  readonly makeStorePool?: StorePoolFactory;
}

export interface RunOptions extends ProvisionOptions {
  readonly handoff: SandcastleHandoff;
}

/**
 * `dustcastle run` (single agent): provision from the shared Store, then hand the
 * Store-mounted Sandbox to sandcastle's flow (ADR 0002). dustcastle owns the
 * Sandbox; the agent/branch/prompt config is sandcastle's domain, passed through
 * unchanged. The per-project deps-staging runs as an onSandboxReady hook (ahead of
 * any caller hooks) so `go test -mod=vendor` finds its vendor/ dir.
 */
export async function run(
  opts: RunOptions,
): Promise<Awaited<ReturnType<typeof sandcastle.run>>> {
  return withProvisionedSandbox(opts, async ({ provider, withSetupHooks: setup }) => {
    const hooks = setup(opts.handoff.hooks);
    return sandcastle.run({ ...opts.handoff, sandbox: provider, hooks });
  });
}

/** A provisioned sandbox seam shared by single-run and orchestration. */
export interface ProvisionedSandbox {
  readonly prepared: PreparedRun;
  /** The podman provider: Store mounted read-only and pi login mounted. */
  readonly provider: ReturnType<typeof podman>;
  /** Prepend dustcastle's deps-staging hooks ahead of the caller's onSandboxReady. */
  withSetupHooks(
    callerHooks?: SandcastleHandoff["hooks"],
  ): NonNullable<SandcastleHandoff["hooks"]>;
}

function subsystemLogger(logger: Logger | undefined, mod: string): Logger {
  return (logger ?? noopLogger).child({ mod });
}

function defaultStorePool(opts: ProvisionStorePoolOptions): Pool {
  return storePool({
    run: nixPortableRunner(),
    dir: DUSTCASTLE_HOME,
    ...(opts.closures !== undefined ? { closures: opts.closures } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}

/**
 * Provision from the shared Store and pin the closure with scoped GC roots — then
 * run `body` with the Store-mounted podman provider, releasing the roots whatever
 * the outcome (ADR 0002/0007). The single provisioning bracket both `run` (one
 * agent) and `orchestrate` (the multi-phase loop) share, so the GC-root invariant
 * lives in exactly one place.
 */
export async function withProvisionedSandbox<T>(
  opts: ProvisionOptions,
  body: (sandbox: ProvisionedSandbox) => Promise<T>,
): Promise<T> {
  // The Store pool, captured as the run sets it up so the single finally tears down
  // whatever was established — even if provisioning or the body throws.
  let pool: Pool | undefined;
  const storePinnedKeys: string[] = [];
  // The deps-cache pool + the keys this run pins in it (ADR 0012). A live run pins
  // ALL its deps-cache entries so a concurrent GC sweep never evicts assembled deps
  // out from under it; released on completion (the finally).
  const cacheDir = opts.depsCacheDir ?? defaultDepsCacheDir();
  const gcLogger = subsystemLogger(opts.logger, "gc");
  const storeLogger = subsystemLogger(opts.logger, "store");
  const depsLogger = subsystemLogger(opts.logger, "deps-cache");
  const sandboxLogger = subsystemLogger(opts.logger, "sandbox");
  const cachePool = depsCachePool({ cacheDir, logger: depsLogger });
  const cachePinnedKeys: string[] = [];

  try {
    const prepared = await prepareRun({
      ...opts,
      logger: storeLogger,
      depsCacheDir: cacheDir,
    });

    // Surface the provisioned posture now — after the Store is realized, the single
    // banner point (the CLI prints here instead of a separate pre-run prepareRun, so
    // the run provisions exactly once).
    opts.onPrepared?.(prepared);

    // Route the Store's pin/warm/release through the one Pool seam (ADR 0012/0015),
    // symmetric with the deps-cache pool below. The pool owns the GC-root lifecycle
    // and the recency index; no out-of-band registerScopedRoots/registerRecencyRoot
    // /upsertRecency calls remain. A polyglot run contributes one closure per
    // active Toolchain key, deduped by the Store pool key.
    const closures = storeClosures(prepared.ecosystems);
    const makeStorePool = opts.makeStorePool ?? defaultStorePool;
    pool = makeStorePool({ closures, logger: gcLogger });

    // Pin every active Toolchain closure with scoped GC roots (ADR 0007/0012), so a
    // concurrent collect-garbage never deletes paths the live run still needs. Roots
    // are released on completion (below), scoping them to the active run.
    for (const key of closures.keys()) {
      pool.pin(key);
      storePinnedKeys.push(key);
    }

    // Warm every active Toolchain in the recency index + persistent recency root
    // (ADR 0007), so polyglot secondary Toolchains stay warm across runs — distinct
    // from the scoped roots above, which are released on completion. Best-effort per
    // key: a failure only risks a later cold rebuild for that key, never the run.
    for (const key of closures.keys()) {
      try {
        pool.warm?.(key);
      } catch (e) {
        gcLogger.warn({ key, err: (e as Error).message }, "recency update failed (best-effort)");
      }
    }

    // Pin EVERY detected ecosystem's deps-cache entry (ADR 0016), so a concurrent GC
    // sweep never evicts assembled deps out from under the live run — the deps-cache
    // analogue of the Store's scoped roots. A polyglot repo pins all of its entries;
    // released on completion (the finally).
    for (const eco of prepared.ecosystems) {
      const depsKey = eco.cache?.depsKey;
      if (depsKey !== undefined) {
        cachePool.pin(depsKey);
        cachePinnedKeys.push(depsKey);
      }
    }

    // Ensure the dustcastle-owned agent image exists (built once from the shipped
    // Containerfile; idempotent thereafter), the way the Store provision ensures
    // nix-portable. The image carries the agent harness (git/bd/pi) + a writable,
    // keep-id-aligned `agent` user that sandcastle's provider maps the host user onto.
    await ensureImage(AGENT_SPEC, { logger: sandboxLogger });

    // Mount the pi login into the sandbox (~/.pi/agent), so the agent
    // authenticates in-container off the developer's existing `pi login` — no
    // per-provider API key. Mirrors agentstack's mount.
    const authMounts = agentAuthMounts();
    const podmanOptions = {
      ...prepared.plan.podmanOptions,
      mounts: [...(prepared.plan.podmanOptions.mounts ?? []), ...authMounts],
    };
    const provider = podman(podmanOptions);
    const result = await body({
      prepared,
      provider,
      withSetupHooks: (callerHooks) => withSetupHooks(callerHooks, prepared.plan),
    });

    // Populate the deps cache for each cache-MISS ecosystem (ADR 0016) AFTER the run
    // completes — the unambiguous timing, since sandcastle runs `host.onSandboxReady`
    // concurrently with the in-Sandbox install (not after it), so it cannot be relied
    // on to land once the deps are assembled. Copies each worktree stage dir into its
    // deps-key entry, gated by the install-success sentinel. Best-effort: a failed
    // populate only risks a later cache miss, never the run.
    await populateDepsCache(opts.cwd, cacheDir, prepared.plan.populate, depsLogger);

    return result;
  } finally {
    for (const key of storePinnedKeys) pool?.release(key); // drop scoped Store roots — closures become collectable
    for (const key of cachePinnedKeys) cachePool.release(key); // unpin deps-cache entries
    // Fire the detached auto-GC one-shot (ADR 0007), off the hot path. It runs
    // AFTER the scoped roots are released, so the just-finished closure is
    // collectable only if it falls outside the warm byte budget. Best-effort —
    // it can never throw out of this finally (and the child is detached, so a
    // failed/hung sweep can never break the run either).
    triggerAutoGc(opts.logger);
  }
}

/** Spawn the detached `__autogc` one-shot (ADR 0007). Never throws. */
function triggerAutoGc(logger: Logger | undefined): void {
  try {
    spawnAutoGc({ logger: subsystemLogger(logger, "gc") });
  } catch {
    /* best-effort: a failed spawn must never break a run */
  }
}

/**
 * The default budget for the in-Sandbox dep-install hook (ADR 0012). sandcastle's
 * per-hook default is 60s, which a real install (pip resolve + wheel-build, a large
 * `npm install`, `cargo fetch`) routinely blows past; 15 minutes covers an outsized
 * cold install while still bounding a genuinely stuck one. Override globally with
 * the {@link installHookTimeoutMs} env knob.
 */
export const DEFAULT_INSTALL_HOOK_TIMEOUT_MS = 15 * 60_000;

/**
 * Resolve the dep-install hook's timeout (ms). A global escape hatch for repos whose
 * cold install exceeds the {@link DEFAULT_INSTALL_HOOK_TIMEOUT_MS} default:
 * `DUSTCASTLE_INSTALL_TIMEOUT_SECONDS` (seconds, matching the existing
 * `idleTimeoutSeconds` / `DUSTCASTLE_LOG` conventions). Unset → the default; a
 * non-positive or non-numeric value is a config error, surfaced before any Sandbox
 * stands up rather than silently ignored.
 */
export function installHookTimeoutMs(
  env: { readonly DUSTCASTLE_INSTALL_TIMEOUT_SECONDS?: string } = process.env,
): number {
  const raw = env.DUSTCASTLE_INSTALL_TIMEOUT_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_INSTALL_HOOK_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `DUSTCASTLE_INSTALL_TIMEOUT_SECONDS must be a positive integer (seconds), got: ${raw}`,
    );
  }
  return seconds * 1000;
}

/**
 * Prepend dustcastle's per-project hooks to any caller hooks (ADR 0002/0012):
 *   - `sandbox.onSandboxReady` — the in-Sandbox install (or, on a cache hit, just the
 *     git-exclude), ahead of the caller's hooks so `go test -mod=vendor` finds its dir;
 *   - `host.onWorktreeReady` — the deps-cache RESTORE copies (cache hits), run on the
 *     host BEFORE the Sandbox starts, so the assembled deps are already in the worktree.
 * Populate (cache misses) is NOT a hook — it runs after `run()` returns (sandcastle
 * runs `host.onSandboxReady` concurrently with the install, so it can't populate after).
 */
export function withSetupHooks(
  existing: SandcastleHandoff["hooks"],
  plan: SandboxPlan,
  installTimeoutMs: number = installHookTimeoutMs(),
): NonNullable<SandcastleHandoff["hooks"]> {
  // dustcastle's own setup hooks ARE the dep install (ADR 0012). sandcastle caps
  // every onSandboxReady hook at HOOK_TIMEOUT_MS=60s by default — far too short for
  // a real Package Manager install (a pip resolve + wheel-build, `npm install`,
  // `cargo fetch`), which it has no env knob to relax — so we set `timeoutMs`
  // explicitly. Caller hooks keep sandcastle's default; only OUR install gets the
  // generous budget.
  const ourSandbox = plan.setupCommands.map((command) => ({ command, timeoutMs: installTimeoutMs }));
  const ourHost = plan.hostWorktreeReady.map((command) => ({ command }));
  const callerSandbox = existing?.sandbox;
  const callerHost = existing?.host;
  return {
    ...existing,
    sandbox: {
      ...callerSandbox,
      onSandboxReady: [...ourSandbox, ...(callerSandbox?.onSandboxReady ?? [])],
    },
    host: {
      ...callerHost,
      onWorktreeReady: [...ourHost, ...(callerHost?.onWorktreeReady ?? [])],
    },
  };
}

function classifyPopulateLine(line: string): StreamingLogLevel {
  // cp errors and shell diagnostics are debug detail; the progress prefix is info.
  if (line.startsWith("caching")) return "info";
  return "debug";
}

/**
 * Populate the deps cache after a run (ADR 0016): for each cache-MISS
 * ecosystem, copy the worktree's assembled stage dir into its deps-key entry, so the
 * next Sandbox on the same fingerprint restores instead of re-installing. Runs on the
 * host in the worktree (the bind-mount path's worktree IS the project dir). Best-effort
 * per entry — a failed copy only risks a later cache miss, never the run.
 */
export async function populateDepsCache(
  cwd: string,
  cacheDir: string,
  populate: readonly DepsCachePopulate[],
  logger: Logger,
): Promise<void> {
  for (const entry of populate) {
    const warnPopulateFailed = (detail: string): void => {
      logger.warn({ depsKey: entry.depsKey, detail }, "populate deps-cache entry failed (best-effort)");
    };

    try {
      const command = populateCommand({ cacheDir, ...entry });
      const verboseCommand = `echo "caching ${entry.stageDir} deps (key ${entry.depsKey.slice(0, 12)})" >&2; ${command}`;
      const result = await runStreamingAsync("sh", ["-c", verboseCommand], {
        cwd,
        logger,
        label: "populate",
        classifyLine: classifyPopulateLine,
      });
      if (result.status === 0) {
        logger.debug({ depsKey: entry.depsKey, stageDir: entry.stageDir }, "populated deps-cache entry");
      } else {
        warnPopulateFailed(result.stderr.slice(-2000).trim());
      }
    } catch (e) {
      warnPopulateFailed((e as Error).message);
    }
  }
}
