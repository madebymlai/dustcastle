import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { detect, type Detection } from "../detect/index.js";
import { detectWorkspace } from "../detect/workspace.js";
import { ensureEgress, provisionProxyResolvConf } from "../sandbox/egress-runtime.js";
import { deriveEgress, gitRemoteHost, type EgressDecision } from "../sandbox/egress.js";
import { planSandbox, type EcosystemPlan, type SandboxPlan } from "../sandbox/plan.js";
import { AGENT_SPEC, PROXY_SPEC, ensureImage } from "../sandbox/image.js";
import { provisionStore, storeHashOf, type Provisioned } from "../store/index.js";
import {
  defaultGcRootsDir,
  defaultRecencyRootsDir,
  nixPortableRunner,
  registerRecencyRoot,
  registerScopedRoots,
  type NixRunner,
} from "../store/gc.js";
import { closureSizeBytes } from "../store/ceiling.js";
import { upsertRecency } from "../store/recency.js";
import {
  depsCacheDecision,
  populateCommand,
  defaultDepsCacheDir,
  depsCachePool,
  type DepsCachePopulate,
} from "../store/depscache/index.js";
import { spawnAutoGc } from "../cli/autogc.js";
import { noopLogger, type Logger } from "../log/index.js";
import { agentAuthMounts, configuredAgentModelHosts, DUSTCASTLE_HOME } from "../config/global.js";
import { runStreamingAsync, type StreamingLogLevel } from "../process/streaming.js";

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
   * Override the egress proxy URL the in-Sandbox install is routed through (ADR
   * 0005). The orchestration layer supplies this after the proxy is up; defaults
   * to the production proxy container on the internal egress net.
   */
  readonly proxyUrl?: string;
  /**
   * The agent's model-provider API host(s) to allowlist for Agent Egress (ADR
   * 0010), so the in-sandbox agent reaches its LLM even on a pure, offline build.
   * Resolved from the configured model by the entry points (CLI /
   * withProvisionedSandbox); left undefined here so prepareRun stays pure and
   * test-injectable. Undefined ⇒ no agent egress ⇒ a pure build stays closed.
   */
  readonly agentModelHosts?: readonly string[];
  /**
   * Override the deps-cache root (ADR 0012, dustcastle-8od). Tests/e2e inject a
   * scratch dir; production defaults to `~/.dustcastle/deps-cache`. The assembled
   * Project Deps are cached here, one entry per ecosystem keyed by its lockfile hash.
   */
  readonly depsCacheDir?: string;
  /**
   * Stand up the egress backend the moment the egress decision is known — BEFORE
   * the expensive Store provision (ADR 0005/0010). The bracket caller
   * ({@link withProvisionedSandbox}) injects this to fail fast: a host that can't
   * enforce scoped egress aborts here, not after minutes of build work. dustcastle
   * has no unconfined fallback by design, so if this throws, the run throws.
   */
  readonly beforeProvision?: (egress: EgressDecision) => void | Promise<void>;
}

/** The deterministic result of dustcastle's pipeline: detect → provision → plan. */
export interface PreparedRun {
  /** The FIRST detected Ecosystem (the primary). The full set is {@link ecosystems}. */
  readonly detection: Detection;
  /** The primary Ecosystem's provisioned Toolchain. The full set is {@link ecosystems}. */
  readonly provisioned: Provisioned;
  /**
   * Every detected Ecosystem paired with its provisioned Toolchain (ADR 0012). A
   * polyglot repo has more than one; each installs its deps in-Sandbox. The first
   * entry mirrors {@link detection}/{@link provisioned}.
   */
  readonly ecosystems: readonly EcosystemPlan[];
  readonly plan: SandboxPlan;
}

/**
 * The dustcastle contribution to `dustcastle run`: detect EVERY Ecosystem in the
 * directory (ADR 0006/0012 — a polyglot repo surfaces more than one), realize each
 * one's Toolchain into the shared Store (ADR 0008), and plan the Sandbox that mounts
 * the Store read-only with the standing egress (ADR 0002/0005/0012). Deps install
 * in-Sandbox via the sandcastle hook — there is no pure-vs-impure decision. Everything
 * here is dustcastle's own work — before sandcastle's flow begins.
 */
export async function prepareRun(opts: PrepareOptions): Promise<PreparedRun> {
  const resolved = detect(opts.cwd);
  if (resolved.length === 0) {
    throw new Error(`no supported ecosystem detected in ${opts.cwd}`);
  }

  // Derive the standing egress decision (ADR 0005/0010/0012) BEFORE provisioning —
  // it needs only detection, not the realized Store — so the enforcing proxy can be
  // stood up (and fail fast) ahead of the expensive build via `beforeProvision`. The
  // allowlist is the UNION of every detected manager's registry + the git host (a
  // polyglot repo opens both), with the agent's model host alongside.
  const remoteHost = gitRemoteHost(opts.cwd);
  const egress: EgressDecision = deriveEgress({
    packageManagers: resolved.map((d) => d.packageManager),
    // Open the hosts of any git-sourced deps (ADR 0012, dustcastle-61j): scanned from the
    // detected managers' declared source files under cwd (manifests ∪ lockfiles).
    projectDir: opts.cwd,
    ...(remoteHost !== undefined ? { gitRemoteHost: remoteHost } : {}),
    // Agent Egress (ADR 0010): the model host(s) carve a route for the agent's own
    // LLM calls alongside the build's standing registry/git egress.
    ...(opts.agentModelHosts !== undefined ? { agentModelHosts: opts.agentModelHosts } : {}),
  });

  // Fail fast: stand up the egress proxy now. If this host can't enforce scoped
  // egress, abort BEFORE provisioning (no unconfined fallback — ADR 0005/0010).
  await opts.beforeProvision?.(egress);

  // The deps-cache root (ADR 0012, dustcastle-8od): the host-owned cache, one entry
  // per ecosystem keyed by its lockfile hash.
  const cacheDir = opts.depsCacheDir ?? defaultDepsCacheDir();

  // Provision EACH detected Ecosystem's Toolchain into the shared Store (ADR 0012:
  // the Store realizes only Toolchains; deps install in-Sandbox). A polyglot repo
  // provisions every Toolchain. Decide each ecosystem's deps-cache hit/miss host-side
  // (keyed by its lockfile hash), so the plan emits restore-vs-install per ecosystem.
  const logger = opts.logger ?? noopLogger;
  const ecosystems: EcosystemPlan[] = [];
  for (const detection of resolved) {
    const cache = depsCacheDecision(opts.cwd, detection, cacheDir);
    const provisioned = await provisionStore({
      projectDir: opts.cwd,
      detection,
      ...(opts.nixPortable !== undefined ? { nixPortable: opts.nixPortable } : {}),
      ...(opts.physStoreRoot !== undefined ? { physStoreRoot: opts.physStoreRoot } : {}),
      logger,
    });
    ecosystems.push({
      detection,
      provisioned,
      ...(cache !== undefined ? { cache } : {}),
    });
  }

  const primary = ecosystems[0]!;
  return {
    detection: primary.detection,
    provisioned: primary.provisioned,
    ecosystems,
    plan: planSandbox({
      provisioned: primary.provisioned,
      detection: primary.detection,
      cacheDir,
      ...(primary.cache !== undefined ? { cache: primary.cache } : {}),
      ...(ecosystems.length > 1 ? { additionalEcosystems: ecosystems.slice(1) } : {}),
      egress,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
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

/** The default in-container path the production proxy image is expected to bundle. */
const DEFAULT_PROXY_ENTRYPOINT = "/opt/dustcastle/proxy-main.js";

/**
 * Everything `withProvisionedSandbox` needs to provision the Store, stand up the
 * egress backend, and pin the GC roots — i.e. a run minus the agent handoff.
 */
export interface ProvisionOptions extends PrepareOptions {
  /**
   * Called once after the Store is provisioned and the egress backend is up — the
   * single point where the CLI prints its "provisioned …" posture banner. Routing
   * the banner through here (rather than a standalone pre-run `prepareRun`) keeps
   * the run to ONE provision and preserves fail-fast: if egress can't be enforced,
   * the run aborts before provisioning and this never fires.
   */
  readonly onPrepared?: (prepared: PreparedRun) => void;
  /** In-container path to the proxy entrypoint for the production egress backend. */
  readonly proxyEntrypoint?: string;
  /** Image carrying a Node runtime for the egress proxy container. */
  readonly proxyImage?: string;
  /**
   * Override the scoped GC-root plumbing (ADR 0007). Tests/e2e inject a nix runner
   * and a scratch gcroots dir; production defaults to a real nix-portable spawn
   * against the dustcastle-owned `~/.dustcastle/gcroots`.
   */
  readonly gcRoots?: { readonly gcrootsDir?: string; readonly run?: NixRunner };
  /**
   * Override the auto-GC plumbing (ADR 0007). After the run completes, dustcastle
   * upserts this project's recency record + a persistent recency root, then spawns
   * the detached `__autogc` one-shot. Tests/e2e set `disabled: true` (don't touch
   * `~` or spawn a child) or inject the runner / dirs / spawn fn; production uses
   * the dustcastle-owned home + a real nix-portable spawn.
   */
  readonly autoGc?: {
    readonly disabled?: boolean;
    readonly run?: NixRunner;
    readonly recencyDir?: string;
    readonly recencyRootsDir?: string;
    readonly spawn?: () => void;
  };
}

export interface RunOptions extends ProvisionOptions {
  readonly handoff: SandcastleHandoff;
}

export interface GcProjectKeyInput {
  readonly detection: Pick<Detection, "packageManager">;
  readonly provisioned: Pick<Provisioned, "toolchainStorePath">;
}

/**
 * A stable key for the realized Toolchain closure this run pins (ADR 0007/0012).
 * The Store realizes only Toolchains now, so the key names the physical closure by
 * package manager plus the Toolchain store hash. Projects sharing one Toolchain
 * share one recency/root record; different Toolchains no longer collide.
 */
export function gcProjectKey(prepared: GcProjectKeyInput): string {
  return `${prepared.detection.packageManager}-${storeHashOf(prepared.provisioned.toolchainStorePath)}`;
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

/** A provisioned, confined sandbox seam shared by single-run and orchestration. */
export interface ProvisionedSandbox {
  readonly prepared: PreparedRun;
  /** The podman provider: Store mounted read-only, pi login mounted, egress applied. */
  readonly provider: ReturnType<typeof podman>;
  /** Prepend dustcastle's deps-staging hooks ahead of the caller's onSandboxReady. */
  withSetupHooks(
    callerHooks?: SandcastleHandoff["hooks"],
  ): NonNullable<SandcastleHandoff["hooks"]>;
}

function subsystemLogger(logger: Logger | undefined, mod: string): Logger {
  return (logger ?? noopLogger).child({ mod });
}

/**
 * Provision from the shared Store, stand up the egress backend the plan routes
 * through, and pin the closure with scoped GC roots — then run `body` with the
 * Store-mounted podman provider, releasing the roots and tearing the egress down
 * whatever the outcome (ADR 0002/0005/0007). The single confinement bracket both
 * `run` (one agent) and `orchestrate` (the multi-phase loop) share, so the
 * egress/GC-root invariants live in exactly one place.
 */
export async function withProvisionedSandbox<T>(
  opts: ProvisionOptions,
  body: (sandbox: ProvisionedSandbox) => Promise<T>,
): Promise<T> {
  // Resolve Agent Egress (ADR 0010): the configured model's API host, so the plan
  // opens a route for the in-sandbox agent's LLM even on a pure build. An explicit
  // opt wins (tests); otherwise read it from the global config (throws actionably
  // on an unknown provider, before any sandbox is stood up).
  const agentModelHosts = opts.agentModelHosts ?? configuredAgentModelHosts();

  // The egress backend and the scoped GC roots, captured as the run sets them up so
  // the single finally tears down whatever was established — even if provisioning or
  // the body throws after egress came up.
  let egress: ReturnType<typeof ensureEgress> = { teardown: () => {} };
  let roots: ReturnType<typeof registerScopedRoots> | undefined;
  // The deps-cache pool + the keys this run pins in it (ADR 0012). A live run pins
  // ALL its deps-cache entries so a concurrent GC sweep never evicts assembled deps
  // out from under it; released on completion (the finally).
  const cacheDir = opts.depsCacheDir ?? defaultDepsCacheDir();
  const gcLogger = subsystemLogger(opts.logger, "gc");
  const storeLogger = subsystemLogger(opts.logger, "store");
  const depsLogger = subsystemLogger(opts.logger, "deps-cache");
  const egressLogger = subsystemLogger(opts.logger, "egress");
  const sandboxLogger = subsystemLogger(opts.logger, "sandbox");
  const cachePool = depsCachePool({ cacheDir, logger: depsLogger });
  const cachePinnedKeys: string[] = [];

  try {
    const prepared = await prepareRun({
      ...opts,
      logger: storeLogger,
      depsCacheDir: cacheDir,
      ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
      // Stand up the production egress backend the moment the decision is known —
      // BEFORE the Store provision (ADR 0005/0010). A host that can't enforce scoped
      // egress fails fast here, before any build work; dustcastle has no unconfined
      // fallback. Torn down in the finally whatever the outcome.
      beforeProvision: async (decision) => {
        // Only the allowlist (impure) path runs a proxy, so build its image lazily
        // there — the dustcastle-owned image that actually carries the proxy code
        // (stock node:20-alpine has none, which left the proxy dead-on-arrival).
        let image = opts.proxyImage;
        if (image === undefined && decision.kind === "allowlist") {
          image = await ensureImage(PROXY_SPEC, { logger: egressLogger });
        }
        // The proxy resolves allowlisted hosts through external resolvers, not the
        // --internal net's aardvark (which would NXDOMAIN-poison resolution).
        const resolvConfPath = decision.kind === "allowlist" ? provisionProxyResolvConf() : undefined;
        egress = ensureEgress({
          egress: decision,
          proxyEntrypoint: opts.proxyEntrypoint ?? DEFAULT_PROXY_ENTRYPOINT,
          ...(image !== undefined ? { image } : {}),
          ...(resolvConfPath !== undefined ? { resolvConfPath } : {}),
          logger: egressLogger,
        });
      },
    });

    // Surface the provisioned posture now — after egress is up and the Store is
    // realized, the single banner point (the CLI prints here instead of a separate
    // pre-run prepareRun, so the run provisions exactly once and stays fail-fast).
    opts.onPrepared?.(prepared);

    // Pin this run's Toolchain closure with scoped GC roots (ADR 0007/0012), so a
    // concurrent collect-garbage never deletes paths the live run still needs. Roots
    // are released on completion (below), scoping them to the active run.
    roots = registerScopedRoots({
      provisioned: prepared.provisioned,
      gcrootsDir: opts.gcRoots?.gcrootsDir ?? defaultGcRootsDir(),
      projectKey: gcProjectKey(prepared),
      ...(opts.gcRoots?.run !== undefined ? { run: opts.gcRoots.run } : {}),
      logger: gcLogger,
    });

    // Persist this project as recently-used + pin a PERSISTENT recency root (ADR
    // 0007), so its Toolchain stays warm across runs — distinct from the scoped root
    // above, which is released on completion. Best-effort: a failure only risks a
    // later cold rebuild, never the run.
    updateRecency(opts, prepared);

    // Pin EVERY detected ecosystem's deps-cache entry (ADR 0012, dustcastle-8od), so a
    // concurrent GC sweep never evicts assembled deps out from under the live run —
    // the deps-cache analogue of the Store's scoped roots. A polyglot repo pins all of
    // its entries; released on completion (the finally). Uncacheable (loose) ecosystems
    // have no entry and contribute no pin.
    for (const eco of prepared.ecosystems) {
      const hash = eco.cache?.lockfileHash;
      if (hash !== undefined) {
        cachePool.pin(hash);
        cachePinnedKeys.push(hash);
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

    // Populate the deps cache for each cache-MISS ecosystem (ADR 0012, dustcastle-8od)
    // AFTER the run completes — the unambiguous timing, since sandcastle runs
    // `host.onSandboxReady` concurrently with the in-Sandbox install (not after it),
    // so it cannot be relied on to land once the deps are assembled. Copies each
    // worktree stage dir into its lockfile-hash entry. Best-effort: a failed populate
    // only risks a later cache miss, never the run.
    await populateDepsCache(opts.cwd, cacheDir, prepared.plan.populate, depsLogger);

    return result;
  } finally {
    roots?.release(); // drop this run's scoped GC roots — closure becomes collectable
    for (const key of cachePinnedKeys) cachePool.release(key); // unpin deps-cache entries
    egress.teardown();
    // Fire the detached auto-GC one-shot (ADR 0007), off the hot path. It runs
    // AFTER the scoped roots are released, so the just-finished closure is
    // collectable only if it falls outside the warm byte budget. Best-effort —
    // it can never throw out of this finally (and the child is detached, so a
    // failed/hung sweep can never break the run either).
    triggerAutoGc(opts);
  }
}

/**
 * Upsert the project's recency record (last-used + closure size) and register its
 * persistent recency root (ADR 0007). Best-effort and fully injectable: disabled or
 * redirected via `opts.autoGc` (tests/e2e), otherwise the dustcastle-owned home +
 * a real nix-portable runner.
 */
function updateRecency(opts: ProvisionOptions, prepared: PreparedRun): void {
  if (opts.autoGc?.disabled === true) return;
  const gcLogger = subsystemLogger(opts.logger, "gc");
  try {
    const dir = opts.autoGc?.recencyDir ?? DUSTCASTLE_HOME;
    const recencyRootsDir = opts.autoGc?.recencyRootsDir ?? defaultRecencyRootsDir();
    const runner = opts.autoGc?.run ?? opts.gcRoots?.run ?? nixPortableRunner();
    const projectKey = gcProjectKey(prepared);
    const closurePath = prepared.provisioned.toolchainStorePath;
    const closureBytes = closurePath.length > 0 ? closureSizeBytes(runner, closurePath) : 0;
    upsertRecency(dir, { projectKey, lastUsedAt: Date.now(), closureBytes });
    registerRecencyRoot({
      provisioned: prepared.provisioned,
      recencyRootsDir,
      projectKey,
      run: runner,
      logger: gcLogger,
    });
  } catch (e) {
    gcLogger.warn({ err: (e as Error).message }, "recency update failed (best-effort)");
  }
}

/** Spawn the detached `__autogc` one-shot, unless disabled/injected (ADR 0007). Never throws. */
function triggerAutoGc(opts: ProvisionOptions): void {
  if (opts.autoGc?.disabled === true) return;
  try {
    if (opts.autoGc?.spawn !== undefined) opts.autoGc.spawn();
    else spawnAutoGc({ logger: subsystemLogger(opts.logger, "gc") });
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
  if (line.startsWith("populating")) return "info";
  return "debug";
}

/**
 * Populate the deps cache after a run (ADR 0012, dustcastle-8od): for each cache-MISS
 * ecosystem, copy the worktree's assembled stage dir into its lockfile-hash entry, so
 * the next Sandbox on the same lockfile restores instead of re-installing. Runs on the
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
      logger.warn({ lockfileHash: entry.lockfileHash, detail }, "populate deps-cache entry failed (best-effort)");
    };

    try {
      const command = populateCommand({ cacheDir, ...entry });
      const verboseCommand = `echo "populating ${entry.lockfileHash}/${entry.stageDir}" >&2; ${command}`;
      const result = await runStreamingAsync("sh", ["-c", verboseCommand], {
        cwd,
        logger,
        label: "populate",
        classifyLine: classifyPopulateLine,
      });
      if (result.status === 0) {
        logger.debug({ lockfileHash: entry.lockfileHash, stageDir: entry.stageDir }, "populated deps-cache entry");
      } else {
        warnPopulateFailed(result.stderr.slice(-2000).trim());
      }
    } catch (e) {
      warnPopulateFailed((e as Error).message);
    }
  }
}
