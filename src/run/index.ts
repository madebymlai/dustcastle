import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { detect, type Detection } from "../detect/index.js";
import { detectWorkspace } from "../detect/workspace.js";
import { parseImpurityMode, type ImpurityDecision, type ImpurityMode } from "../impurity/index.js";
import { ensureEgress, provisionProxyResolvConf } from "../sandbox/egress-runtime.js";
import { deriveEgress, type EgressDecision } from "../sandbox/egress.js";
import { planSandbox, type SandboxPlan } from "../sandbox/plan.js";
import { ensureAgentImage } from "../sandbox/agent-image.js";
import { ensureProxyImage } from "../sandbox/proxy-image.js";
import { provisionStore, type Provisioned } from "../store/index.js";
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
import { spawnAutoGc } from "../cli/autogc.js";
import { gitRemoteHost, resolveImpurity, writeImpurityMarker } from "./impurity.js";
import { exportRequirements, pinLooseManifest, type Exported, type Pinned, type ResolveRunner } from "./pin.js";
import { agentAuthMounts, configuredAgentModelHosts, DUSTCASTLE_HOME } from "../config/global.js";

export interface PrepareOptions {
  /** The project directory to run in (defaults to the process cwd at the CLI). */
  readonly cwd: string;
  /** Override the nix-portable binary path; defaults to the dustcastle-owned copy. */
  readonly nixPortable?: string;
  /** Override the physical rootless store root. */
  readonly physStoreRoot?: string;
  /** Supply a known deps hash to skip discovery (the single hash for any ecosystem). */
  readonly depsHash?: string;
  /** Stream provisioning output (progress surfacing). */
  readonly onLine?: (line: string) => void;
  /** Environment to source the impurity mode from (ADR 0005); defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Force the impurity mode, bypassing env (tests / explicit callers). */
  readonly impurityMode?: ImpurityMode;
  /** Whether the run is unattended (no human to confirm `ask`). Defaults to true. */
  readonly headless?: boolean;
  /**
   * Override the egress proxy URL the impure container is routed through (ADR
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
   * Inject the lock-only resolve runner for the pin-then-pure step (ADR 0006c).
   * Tests/e2e override it; defaults to a real spawn of the manager's resolve.
   */
  readonly pin?: ResolveRunner;
  /**
   * Inject the export front-end runner (ADR 0006 amendment) — the `uv export` step
   * that materialises the pip-FOD's requirements.txt from uv.lock. Tests/e2e
   * override it; defaults to a real spawn.
   */
  readonly export?: ResolveRunner;
  /**
   * Stand up the egress backend the moment the egress decision is known — BEFORE
   * the expensive Store provision (ADR 0005/0010). The bracket caller
   * ({@link withProvisionedSandbox}) injects this to fail fast: a host that can't
   * enforce scoped egress aborts here, not after minutes of build work. dustcastle
   * has no unconfined fallback by design, so if this throws, the run throws.
   */
  readonly beforeProvision?: (egress: EgressDecision) => void;
}

/** The deterministic result of dustcastle's pipeline: detect → provision → plan. */
export interface PreparedRun {
  readonly detection: Detection;
  readonly provisioned: Provisioned;
  readonly plan: SandboxPlan;
  /** The impurity decision applied (ADR 0004), surfaced so callers can report it. */
  readonly impurity: ImpurityDecision;
  /**
   * The lockfile pin-then-pure generated for a loose manifest (ADR 0006c),
   * surfaced (never silent) so the CLI can report the new committed artifact.
   * Undefined when the manifest was already lock-pinned.
   */
  readonly pinned?: Pinned;
  /**
   * The requirements.txt an export front-end produced from a richer lockfile (uv's
   * `uv export`, poetry's `poetry export`; ADR 0006 amendment / laimk-hse.7),
   * surfaced (never silent). Undefined for managers that consume their lockfile
   * directly (pip) or are still gated (bun).
   */
  readonly exported?: Exported;
}

/**
 * The dustcastle contribution to `dustcastle run`: detect the Ecosystem (ADR
 * 0006), resolve the impurity policy (ADR 0004), realize the Toolchain + Project
 * Deps into the shared Store (ADR 0004/0008), and plan the Sandbox that mounts
 * the Store read-only with the derived egress (ADR 0002/0005). Everything here is
 * dustcastle's own work — before sandcastle's flow begins.
 */
export function prepareRun(opts: PrepareOptions): PreparedRun {
  let detection = detect(opts.cwd)[0];
  if (detection === undefined) {
    throw new Error(`no supported ecosystem detected in ${opts.cwd}`);
  }

  // Pin-then-pure (ADR 0006c). A loose manifest (a package.json with no lockfile)
  // is resolved ONCE into a generated, committed lockfile, then re-detected so the
  // build runs pure/offline against that lock — strictly better than going impure.
  let pinned: Pinned | undefined;
  if (detection.loose === true) {
    pinned = pinLooseManifest({
      cwd: opts.cwd,
      packageManager: detection.packageManager,
      ...(opts.pin !== undefined ? { run: opts.pin } : {}),
      ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
    });
    const repinned = detect(opts.cwd)[0];
    if (repinned === undefined) {
      throw new Error(`pin-then-pure: ${pinned.lockfile} was not generated in ${opts.cwd}`);
    }
    detection = repinned;
  }

  // Resolve impurity (ADR 0004). Pure ecosystems (Go) never need it; for Node it
  // is read from the lockfile, then run through the allow/ask/deny state machine.
  const mode = opts.impurityMode ?? parseImpurityMode(opts.env ?? process.env);
  const impurity = resolveImpurity({
    cwd: opts.cwd,
    detection,
    mode,
    headless: opts.headless ?? true,
    env: opts.env ?? process.env,
  });
  if (impurity.kind === "deny") throw new Error(impurity.reason);

  const impure = impurity.kind === "impure";
  if (impure && impurity.kind === "impure") {
    // Asynchronous consent: record the visible, version-controlled marker.
    writeImpurityMarker(opts.cwd, impurity.marker);
  }

  // Export front-end (ADR 0006 amendment). A manager whose own lockfile isn't the
  // pip-FOD's input — uv (uv.lock) — materialises the hash-pinned requirements.txt
  // IN PLACE before provisioning, so the staged source carries the file the
  // importer reads. A no-op for pip (reads requirements.txt directly) and gated
  // poetry. Surfaced (never silent), like the pin step.
  const exported = exportRequirements({
    cwd: opts.cwd,
    packageManager: detection.packageManager,
    ...(opts.export !== undefined ? { run: opts.export } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
  });

  // Derive the egress decision (ADR 0005/0010) BEFORE provisioning — it needs only
  // detection/impurity, not the realized Store — so the enforcing proxy can be stood
  // up (and fail fast) ahead of the expensive build via `beforeProvision`.
  const remoteHost = impure ? gitRemoteHost(opts.cwd) : undefined;
  const egress: EgressDecision = deriveEgress({
    packageManager: detection.packageManager,
    impure,
    ...(remoteHost !== undefined ? { gitRemoteHost: remoteHost } : {}),
    // Agent Egress (ADR 0010): the model host(s) carve a route for the agent's own
    // LLM calls out of the build's network posture — even when the build is pure.
    ...(opts.agentModelHosts !== undefined ? { agentModelHosts: opts.agentModelHosts } : {}),
  });

  // Fail fast: stand up the egress proxy now. If this host can't enforce scoped
  // egress, abort BEFORE provisioning (no unconfined fallback — ADR 0005/0010).
  opts.beforeProvision?.(egress);

  const provisioned = provisionStore({
    projectDir: opts.cwd,
    detection,
    impure,
    ...(opts.nixPortable !== undefined ? { nixPortable: opts.nixPortable } : {}),
    ...(opts.physStoreRoot !== undefined ? { physStoreRoot: opts.physStoreRoot } : {}),
    ...(opts.depsHash !== undefined ? { depsHash: opts.depsHash } : {}),
    ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
  });

  return {
    detection,
    provisioned,
    plan: planSandbox({
      provisioned,
      detection,
      egress,
      ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
    }),
    impurity,
    ...(pinned !== undefined ? { pinned } : {}),
    ...(exported !== undefined ? { exported } : {}),
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
 * detect → pin → provision → plan pipeline for EACH (consistent with per-directory
 * accumulation — a member is just another directory). Falls back to the single
 * root project when `root` declares no workspace, so callers can use this
 * uniformly. Members with no detected ecosystem (e.g. a docs-only package) are
 * skipped — there is nothing to provision.
 */
export function prepareWorkspace(opts: PrepareOptions): PreparedWorkspace {
  const ws = detectWorkspace(opts.cwd);
  const members = ws.projects
    .filter((project) => project.detections.length > 0)
    .map((project) => ({ dir: project.dir, prepared: prepareRun({ ...opts, cwd: project.dir }) }));
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

/**
 * A stable key for a project's realized closure (ADR 0007 — roots keyed by deps
 * state). The deps hash IS the lockfile-derived FOD hash; pairing it with the
 * manager uniquely identifies this project's roots so they replace cleanly when the
 * lockfile changes and never collide with another project's.
 */
function gcProjectKey(prepared: PreparedRun): string {
  return `${prepared.detection.packageManager}-${prepared.provisioned.depsHash || "toolchain"}`;
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

  try {
    const prepared = prepareRun({
      ...opts,
      ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
      // Stand up the production egress backend the moment the decision is known —
      // BEFORE the Store provision (ADR 0005/0010). A host that can't enforce scoped
      // egress fails fast here, before any build work; dustcastle has no unconfined
      // fallback. Torn down in the finally whatever the outcome.
      beforeProvision: (decision) => {
        // Only the allowlist (impure) path runs a proxy, so build its image lazily
        // there — the dustcastle-owned image that actually carries the proxy code
        // (stock node:20-alpine has none, which left the proxy dead-on-arrival).
        const image =
          opts.proxyImage ??
          (decision.kind === "allowlist"
            ? ensureProxyImage(opts.onLine !== undefined ? { onLine: opts.onLine } : {})
            : undefined);
        // The proxy resolves allowlisted hosts through external resolvers, not the
        // --internal net's aardvark (which would NXDOMAIN-poison resolution).
        const resolvConfPath = decision.kind === "allowlist" ? provisionProxyResolvConf() : undefined;
        egress = ensureEgress({
          egress: decision,
          proxyEntrypoint: opts.proxyEntrypoint ?? DEFAULT_PROXY_ENTRYPOINT,
          ...(image !== undefined ? { image } : {}),
          ...(resolvConfPath !== undefined ? { resolvConfPath } : {}),
          ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
        });
      },
    });

    // Surface the provisioned posture now — after egress is up and the Store is
    // realized, the single banner point (the CLI prints here instead of a separate
    // pre-run prepareRun, so the run provisions exactly once and stays fail-fast).
    opts.onPrepared?.(prepared);

    // Pin this run's toolchain + deps closure with scoped GC roots (ADR 0007), so a
    // concurrent collect-garbage never deletes paths the live run still needs. Roots
    // are released on completion (below), scoping them to the active run.
    roots = registerScopedRoots({
      provisioned: prepared.provisioned,
      gcrootsDir: opts.gcRoots?.gcrootsDir ?? defaultGcRootsDir(),
      projectKey: gcProjectKey(prepared),
      ...(opts.gcRoots?.run !== undefined ? { run: opts.gcRoots.run } : {}),
      ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
    });

    // Persist this project as recently-used + pin a PERSISTENT recency root (ADR
    // 0007), so its Toolchain stays warm across runs — distinct from the scoped root
    // above, which is released on completion. Best-effort: a failure only risks a
    // later cold rebuild, never the run.
    updateRecency(opts, prepared);

    // Ensure the dustcastle-owned agent image exists (built once from the shipped
    // Containerfile; idempotent thereafter), the way the Store provision ensures
    // nix-portable. The image carries the agent harness (git/bd/pi) + a writable,
    // keep-id-aligned `agent` user that sandcastle's provider maps the host user onto.
    ensureAgentImage(opts.onLine !== undefined ? { onLine: opts.onLine } : {});

    // Mount the pi login into the sandbox (~/.pi/agent), so the agent
    // authenticates in-container off the developer's existing `pi login` — no
    // per-provider API key. Mirrors agentstack's mount.
    const authMounts = agentAuthMounts();
    const podmanOptions = {
      ...prepared.plan.podmanOptions,
      mounts: [...(prepared.plan.podmanOptions.mounts ?? []), ...authMounts],
    };
    const provider = podman(podmanOptions);
    return await body({
      prepared,
      provider,
      withSetupHooks: (callerHooks) =>
        withSetupHooks(callerHooks, prepared.plan.setupCommands),
    });
  } finally {
    roots?.release(); // drop this run's scoped GC roots — closure becomes collectable
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
  try {
    const dir = opts.autoGc?.recencyDir ?? DUSTCASTLE_HOME;
    const recencyRootsDir = opts.autoGc?.recencyRootsDir ?? defaultRecencyRootsDir();
    const runner = opts.autoGc?.run ?? opts.gcRoots?.run ?? nixPortableRunner();
    const projectKey = gcProjectKey(prepared);
    // The deps closure (when present) is the superset that references the toolchain;
    // on the impure path (no deps in the Store) fall back to the toolchain closure.
    const closurePath = prepared.provisioned.depsStorePath || prepared.provisioned.toolchainStorePath;
    const closureBytes = closurePath.length > 0 ? closureSizeBytes(runner, closurePath) : 0;
    upsertRecency(dir, { projectKey, lastUsedAt: Date.now(), closureBytes });
    registerRecencyRoot({
      provisioned: prepared.provisioned,
      recencyRootsDir,
      projectKey,
      run: runner,
      ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}),
    });
  } catch (e) {
    opts.onLine?.(`gc: WARNING recency update failed (best-effort): ${(e as Error).message}`);
  }
}

/** Spawn the detached `__autogc` one-shot, unless disabled/injected (ADR 0007). Never throws. */
function triggerAutoGc(opts: ProvisionOptions): void {
  if (opts.autoGc?.disabled === true) return;
  try {
    if (opts.autoGc?.spawn !== undefined) opts.autoGc.spawn();
    else spawnAutoGc({ ...(opts.onLine !== undefined ? { onLine: opts.onLine } : {}) });
  } catch {
    /* best-effort: a failed spawn must never break a run */
  }
}

/** Prepend dustcastle's per-project setup commands to any caller onSandboxReady hooks. */
function withSetupHooks(
  existing: SandcastleHandoff["hooks"],
  setupCommands: string[],
): NonNullable<SandcastleHandoff["hooks"]> {
  const ours = setupCommands.map((command) => ({ command }));
  const callerSandbox = existing?.sandbox;
  return {
    ...existing,
    sandbox: {
      ...callerSandbox,
      onSandboxReady: [...ours, ...(callerSandbox?.onSandboxReady ?? [])],
    },
  };
}
