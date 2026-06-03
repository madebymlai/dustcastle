import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { AGENT_SPEC, imageRef } from "./image.js";
import type { Detection } from "../detect/index.js";
import { ecosystemFor, packageManagerDescriptor } from "../ecosystems/index.js";
import { restoreCommand, type DepsCacheDecision, type DepsCachePopulate } from "../store/depscache/index.js";
import type { Provisioned } from "../store/index.js";
import { EGRESS_NETWORK, productionProxyUrl, proxyEnv } from "./confine.js";
import { deriveEgress, type EgressDecision } from "./egress.js";

/** sandcastle's podman() options — typed from the factory so it stays in sync. */
export type PodmanOptions = NonNullable<Parameters<typeof podman>[0]>;

/** One detected Ecosystem paired with its provisioned Toolchain (ADR 0012). */
export interface EcosystemPlan {
  readonly provisioned: Provisioned;
  readonly detection: Detection;
  /**
   * The host-side deps-cache decision for this ecosystem (ADR 0012, dustcastle-8od).
   * Absent for a caller that does not cache (the prior always-install behavior).
   */
  readonly cache?: DepsCacheDecision;
}

export type EcosystemPlans = readonly [EcosystemPlan, ...EcosystemPlan[]];

export interface SandboxPlanSpec {
  /**
   * Every detected Ecosystem in this run, paired with its provisioned Toolchain.
   * The non-empty tuple captures prepareRun's zero-detection guard at the type level.
   */
  readonly ecosystems: EcosystemPlans;
  /**
   * The deps-cache root (under the dustcastle home) shared by every ecosystem in this
   * run. Required when any cache decision with a stable lockfile hash is supplied.
   */
  readonly cacheDir?: string;
  /**
   * The egress decision (ADR 0005/0012). A standing allowlist that no longer branches
   * on purity — every detected manager's registry is open and deps install in-Sandbox.
   * Defaults to the union derived from every detected manager's registry. `{ kind:
   * "none" }` only when no Ecosystem is detected and no agent runs.
   */
  readonly egress?: EgressDecision;
  /**
   * The URL of the running egress proxy to route the container's tooling through
   * (ADR 0005). Only used on the allowlist path. Defaults to the production proxy
   * container's name on the internal egress net; the live e2e overrides it with
   * its host-side proxy address.
   */
  readonly proxyUrl?: string;
  /**
   * Base image; a stock image suffices for libc (the Nix closure carries its own),
   * but it MUST ship git — the agent branches/commits/merges. Defaults to a
   * git-preinstalled image; an override must keep that guarantee.
   */
  readonly imageName?: string;
}

/**
 * What dustcastle hands sandcastle: the podman() provider options (the ADR 0002
 * `mounts` seam + the Toolchain env), plus the host/sandbox hooks that restore or
 * install Project Deps. `egress` is surfaced so the CLI can print the network
 * posture — never silent (ADR 0005).
 */
export interface SandboxPlan {
  readonly podmanOptions: PodmanOptions;
  /** Commands to run on sandbox-ready (sandcastle hooks.sandbox.onSandboxReady). */
  readonly setupCommands: string[];
  /**
   * Commands to run on the HOST before the Sandbox starts (sandcastle
   * hooks.host.onWorktreeReady): the deps-cache RESTORE copies (ADR 0012). On a cache
   * hit, the assembled deps are copied from the lockfile-hash entry into the worktree's
   * stage dir (cp -RL + chmod self-heal, the same shape the old Store staging used).
   * Empty when every ecosystem misses (or no caching) — then the install runs in-Sandbox.
   */
  readonly hostWorktreeReady: string[];
  /**
   * The cache entries to POPULATE after the run completes (ADR 0012) — one per
   * cache-missed ecosystem. The orchestration layer copies each worktree stage dir
   * into its lockfile-hash entry once the in-Sandbox install has assembled it. Empty
   * when every ecosystem hit (or is uncacheable).
   */
  readonly populate: DepsCachePopulate[];
  /** The egress decision applied, surfaced for the CLI (ADR 0005). */
  readonly egress: EgressDecision;
}

/**
 * The dustcastle-owned agent image (built once via {@link ensureImage}): it
 * ships the agent harness (git, bd, pi) and a writable, keep-id-aligned `agent`
 * user, while the language Toolchain still comes from the Nix closure mounted at
 * /nix/store (ADR 0008). A stock base image has no `agent` user/writable home, so
 * sandcastle's `git config --global` step can't run in it — hence dustcastle owns
 * this image the way it owns nix-portable.
 */
// The SAME content-busting ref ensureImage(AGENT_SPEC) builds — derived through the
// one imageRef so the run site can never address a tag the build site didn't produce.
const DEFAULT_IMAGE = imageRef(AGENT_SPEC);

/**
 * Plan the Sandbox for a provisioned project (ADR 0002): bind-mount the Store
 * read-only at /nix/store, put the Toolchain on PATH, and apply the egress
 * decision (ADR 0005). The integration seam is just the `mounts` array — no fork,
 * no patch.
 */
export function planSandbox(spec: SandboxPlanSpec): SandboxPlan {
  // Every detected Ecosystem (ADR 0012): each provisions its Toolchain and either
  // restores its deps from the cache (hit) or installs them in-Sandbox (miss /
  // uncacheable).
  const ecosystems = spec.ecosystems;
  const primaryEcosystem = ecosystems[0];
  const cacheDir = spec.cacheDir;
  const egress =
    spec.egress ?? deriveEgress({ packageManagers: ecosystems.map((e) => e.detection.packageManager) });

  // On the allowlist path, route the container's tooling through the egress
  // proxy (which enforces the allowlist); confinement makes that proxy its only
  // way out. A closed (`none`) build gets no proxy and no network at all.
  const proxyUrlForBuild = egress.kind === "allowlist" ? spec.proxyUrl ?? productionProxyUrl() : undefined;

  const podmanOptions: PodmanOptions = {
    imageName: spec.imageName ?? DEFAULT_IMAGE,
    mounts: [
      // THE SEAM: the shared Store, read-only, at its canonical path. Every
      // Ecosystem's Toolchain lives in this one content-addressed Store.
      { hostPath: primaryEcosystem.provisioned.physStoreRoot, sandboxPath: "/nix/store", readonly: true },
    ],
    env: {
      // Merge each Ecosystem's run env (PATH + cache vars). A polyglot repo puts
      // every Toolchain on PATH; the proxy env applies once on top of all of them.
      ...mergeEnv(ecosystems),
      ...(proxyUrlForBuild !== undefined ? proxyEnv(proxyUrlForBuild) : {}),
    },
    network: egress.kind === "none" ? "none" : EGRESS_NETWORK,
  };

  // Per ecosystem (ADR 0012, dustcastle-8od): a cache HIT restores the assembled deps
  // on the host before the Sandbox starts (host.onWorktreeReady) and runs no install;
  // a MISS (or an uncacheable loose ecosystem) installs in-Sandbox via the hook, and a
  // MISS additionally populates its cache entry from the worktree after the run. A
  // polyglot repo freely mixes hit + miss across its ecosystems in one Sandbox.
  const setupCommands: string[] = [];
  const hostWorktreeReady: string[] = [];
  const populate: DepsCachePopulate[] = [];
  for (const e of ecosystems) {
    const { sandbox } = ecosystemFor(e.detection.ecosystem);
    const stageDir = sandbox.stageDir;
    const cache = e.cache;
    const lockfileHash = cache?.lockfileHash;

    if (cache !== undefined && lockfileHash !== undefined && cache.hit) {
      // HIT: restore from the cache on the host; the in-Sandbox setup is just the
      // git-exclude (no install, no registry traffic).
      hostWorktreeReady.push(restoreCommand({ cacheDir: requireCacheDir(cacheDir), lockfileHash, stageDir }));
      setupCommands.push(gitExclude(stageDir));
    } else {
      // MISS / uncacheable: install in-Sandbox (git-exclude first, then the install).
      setupCommands.push(...setupFor(e.detection));
      if (cache !== undefined && lockfileHash !== undefined) {
        // A real miss (stable key, no entry yet): populate the cache after the run.
        requireCacheDir(cacheDir);
        populate.push({ lockfileHash, stageDir });
      }
    }
  }

  return { podmanOptions, setupCommands, hostWorktreeReady, populate, egress };
}

function requireCacheDir(cacheDir: string | undefined): string {
  if (cacheDir === undefined) {
    throw new Error("cacheDir is required when a deps-cache decision has a lockfile hash");
  }
  return cacheDir;
}

/**
 * Merge every detected Ecosystem's run env (ADR 0002/0012). Each Ecosystem's
 * `sandbox` facet contributes its Toolchain on PATH plus its writable cache vars;
 * for a polyglot repo the PATH entries are concatenated (each Toolchain's bin),
 * and the rest of the vars union. The per-Ecosystem knowledge of WHICH env to run
 * under lives on the descriptor, not in a per-Ecosystem `if` ladder here.
 */
function mergeEnv(ecosystems: readonly EcosystemPlan[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const { detection, provisioned } of ecosystems) {
    const env = ecosystemFor(detection.ecosystem).sandbox.env(`${provisioned.toolchainStorePath}/bin`);
    for (const [key, value] of Object.entries(env)) {
      // PATH accumulates each Toolchain's bin; everything else is last-write-wins
      // (the writable cache vars point at /tmp regardless of Ecosystem).
      merged[key] = key === "PATH" && merged.PATH !== undefined ? `${merged.PATH}:${value}` : value;
    }
  }
  return merged;
}

/**
 * The per-Ecosystem sandbox-ready setup: install deps in-Sandbox (ADR 0012). The
 * deps land in the Ecosystem's `stageDir` — a build artifact, never project state.
 * Exclude it from the worktree's git FIRST so the agent's `git add` and sandcastle's
 * untracked-sync never capture it (dustcastle-8dk), then run the real Package
 * Manager's resolving install command(s) under the standing egress (it installs from
 * a committed lockfile when present, resolves when not — never branches on `loose`).
 * The install command lives on the dispatch grain (PackageManagerDescriptor.installCommand),
 * so this is ecosystem-AGNOSTIC — node installs node_modules, python installs into
 * ./site, go fetches its modules, cargo fetches its crates — no per-Ecosystem `if`.
 * `installCommand` is REQUIRED on every descriptor (ADR 0012), so there is no
 * "no install command" branch — a half-added Ecosystem fails at `tsc`, not here.
 */
function setupFor(detection: Detection): string[] {
  const { sandbox } = ecosystemFor(detection.ecosystem);
  const exclude = gitExclude(sandbox.stageDir);
  const { installCommand } = packageManagerDescriptor(detection.packageManager);
  return [exclude, ...installCommand];
}

/**
 * Register a worktree-relative staging dir in the worktree's git exclude
 * (`$GIT_DIR/info/exclude`, NOT the project's tracked `.gitignore`), idempotently.
 * The installed deps are a build artifact, never project state — excluding them
 * keeps the agent's `git add` AND sandcastle's untracked-sync (which runs
 * `git ls-files --others --exclude-standard`) from ever capturing them, so they
 * can't bloat the reviewer's `git diff` or leak on merge. Derived from the SAME
 * `stageDir` the in-Sandbox install lands in — one source, no parallel ignore list.
 */
function gitExclude(stageDir: string): string {
  return (
    `f="$(git rev-parse --git-path info/exclude)"; ` +
    `grep -qxF '${stageDir}' "$f" 2>/dev/null || printf '%s\\n' '${stageDir}' >> "$f"`
  );
}
