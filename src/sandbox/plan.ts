import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { AGENT_SPEC } from "./image.js";
import type { Detection } from "../detect/index.js";
import { ecosystemFor, packageManagerDescriptor, type SandboxStaging } from "../ecosystems/index.js";
import type { Provisioned } from "../store/index.js";
import { EGRESS_NETWORK, productionProxyUrl, proxyEnv } from "./confine.js";
import { deriveEgress, type EgressDecision } from "./egress.js";

/** sandcastle's podman() options — typed from the factory so it stays in sync. */
export type PodmanOptions = NonNullable<Parameters<typeof podman>[0]>;

export interface SandboxPlanSpec {
  readonly provisioned: Provisioned;
  readonly detection: Detection;
  /**
   * The egress decision (ADR 0005). Pure builds default to `{ kind: "none" }`;
   * an impure `allow` build supplies a derived allowlist, which both opens scoped
   * egress and switches deps installation to run inside the container.
   */
  readonly egress?: EgressDecision;
  /**
   * Whether this build is impure (deps install in-container vs staged from the
   * Store). Decided independently of egress (ADR 0010): a pure build can carry an
   * allowlist for Agent Egress without being impure. Defaults to inferring it from
   * an empty `provisioned.depsStorePath` — the Store's own impurity contract (the
   * impure path realizes only the Toolchain, leaving depsStorePath empty).
   */
  readonly impure?: boolean;
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
 * `mounts` seam + the Toolchain env) and the per-project setup commands that
 * stage Project Deps from the read-only Store. `egress` is surfaced so the CLI
 * can print the network posture — never silent (ADR 0005).
 */
export interface SandboxPlan {
  readonly podmanOptions: PodmanOptions;
  /** Commands to run on sandbox-ready (sandcastle hooks.sandbox.onSandboxReady). */
  readonly setupCommands: string[];
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
const DEFAULT_IMAGE = AGENT_SPEC.tag;

/**
 * Plan the Sandbox for a provisioned project (ADR 0002): bind-mount the Store
 * read-only at /nix/store, put the Toolchain on PATH, and apply the egress
 * decision (ADR 0005). The integration seam is just the `mounts` array — no fork,
 * no patch.
 */
export function planSandbox(spec: SandboxPlanSpec): SandboxPlan {
  const { provisioned, detection } = spec;
  const egress = spec.egress ?? deriveEgress({ packageManager: detection.packageManager, impure: false });

  // On the allowlist path, route the container's tooling through the egress
  // proxy (which enforces the allowlist); confinement makes that proxy its only
  // way out. Closed (pure) builds get no proxy and no network at all.
  const proxyUrlForBuild = egress.kind === "allowlist" ? spec.proxyUrl ?? productionProxyUrl() : undefined;

  const podmanOptions: PodmanOptions = {
    imageName: spec.imageName ?? DEFAULT_IMAGE,
    mounts: [
      // THE SEAM: the shared Store, read-only, at its canonical path.
      { hostPath: provisioned.physStoreRoot, sandboxPath: "/nix/store", readonly: true },
    ],
    env: {
      ...envFor(detection.ecosystem, provisioned.toolchainStorePath),
      ...(proxyUrlForBuild !== undefined ? proxyEnv(proxyUrlForBuild) : {}),
    },
    network: egress.kind === "none" ? "none" : EGRESS_NETWORK,
  };

  // Impurity (how deps are staged) is decided independently of egress (ADR 0010):
  // an empty depsStorePath means the impure path realized only the Toolchain, so
  // deps install in-container. A caller may force it explicitly (tests).
  const impure = spec.impure ?? provisioned.depsStorePath === "";

  return { podmanOptions, setupCommands: setupFor(detection, provisioned, impure), egress };
}

/**
 * The run environment for a provisioned project (ADR 0002): the Toolchain on PATH
 * plus the writable cache vars that must point off the read-only Store. Driven by
 * the Ecosystem's `sandbox` facet — the per-Ecosystem knowledge of WHICH env to
 * run under lives on the descriptor, not in a per-Ecosystem `if` ladder here.
 */
function envFor(ecosystem: Detection["ecosystem"], toolchainStorePath: string): Record<string, string> {
  return ecosystemFor(ecosystem).sandbox.env(`${toolchainStorePath}/bin`);
}

/** The per-project sandbox-ready setup: stage deps from the Store, or install impurely. */
function setupFor(detection: Detection, provisioned: Provisioned, impure: boolean): string[] {
  // Whether staged (pure) or installed (impure), deps land in the Ecosystem's
  // `stageDir` — a re-staged build artifact, never project state. Exclude it from
  // the worktree's git FIRST so the agent's `git add` and sandcastle's untracked-
  // sync never capture it (dustcastle-8dk). Same `stageDir` both paths populate.
  const { sandbox } = ecosystemFor(detection.ecosystem);
  const exclude = gitExclude(sandbox.stageDir);
  if (impure) {
    // Impure `allow`: install in the container (lifecycle scripts included) under
    // the scoped egress network, with the manager that signalled — this is where
    // untrusted postinstall actually runs. The frozen/immutable install command(s)
    // live on the dispatch grain (PackageManagerDescriptor.impureInstall), so this
    // is ecosystem-AGNOSTIC: node installs node_modules, python installs into ./site
    // (the same dir the pure path stages into), no per-Ecosystem `if` here. Keyed on
    // impurity, NOT the egress shape (ADR 0010) — a pure build may carry an allowlist
    // for the agent's model host yet still stage its deps from the Store.
    const { impureInstall } = packageManagerDescriptor(detection.packageManager);
    if (impureInstall === undefined) {
      // Unreachable given the descriptor invariant (impureInstall iff impuritySignal,
      // and only a manager with an impuritySignal can be decided impure). Throw
      // rather than mis-stage — never silently cp from an empty deps Store path.
      throw new Error(
        `sandbox: ${detection.packageManager} reached the impure path with no impureInstall ` +
          `command (it has no impuritySignal and can never go impure) — refusing to mis-stage.`,
      );
    }
    return [exclude, ...impureInstall];
  }
  // Pure: stage the offline-assembled deps out of the read-only Store, driven by
  // the Ecosystem's `sandbox` facet (ADR 0002) — node_modules for node, site for
  // python (PYTHONPATH points there), vendor for go. The knowledge of WHAT to copy
  // lives on the descriptor, not in a per-Ecosystem `if` ladder here.
  return [exclude, ...stageCommands(sandbox, provisioned.depsStorePath)];
}

/**
 * Register a worktree-relative staging dir in the worktree's git exclude
 * (`$GIT_DIR/info/exclude`, NOT the project's tracked `.gitignore`), idempotently.
 * The staged deps are a re-staged build artifact, never project state — excluding
 * them keeps the agent's `git add` AND sandcastle's untracked-sync (which runs
 * `git ls-files --others --exclude-standard`) from ever capturing them, so they
 * can't bloat the reviewer's `git diff` or leak on merge. Derived from the SAME
 * `stageDir` the staging copies into — one source, no parallel ignore list.
 */
function gitExclude(stageDir: string): string {
  return (
    `f="$(git rev-parse --git-path info/exclude)"; ` +
    `grep -qxF '${stageDir}' "$f" 2>/dev/null || printf '%s\\n' '${stageDir}' >> "$f"`
  );
}

/**
 * Emit the self-healing PURE staging command list for one Ecosystem (ADR 0002):
 * clear the target, `cp -RL` the deps out of the read-only Store, then chmod the
 * copy writable.
 *
 * The clear chmods the target writable BEFORE the `rm`: a `cp -RL` from the
 * read-only Store reproduces the Store's 555 dir mode, so a staging interrupted
 * before the trailing chmod leaves a read-only target — which `rm -rf` then CANNOT
 * remove (no write bit ⇒ can't unlink its contents), poisoning every later run.
 * The leading chmod makes the staging self-healing; `2>/dev/null` + `;` keep it a
 * no-op when nothing is there.
 *
 * The source is `depsStorePath/storeSubpath` (node→/node_modules, python→/site),
 * or `depsStorePath` itself when there is no subpath (go's deps Store path IS the
 * vendor dir). `cp -RL` is uniform across all three — in coreutils `-r` and `-R`
 * are identical, so go's historical `-rL` is normalized to `-RL` (a no-op).
 */
export function stageCommands(facet: SandboxStaging, depsStorePath: string): string[] {
  const { stageDir, storeSubpath } = facet;
  const source = storeSubpath === "" ? depsStorePath : `${depsStorePath}/${storeSubpath}`;
  return [
    `chmod -R u+w ${stageDir} 2>/dev/null; rm -rf ${stageDir}`,
    `cp -RL ${source} ${stageDir}`,
    `chmod -R u+w ${stageDir}`,
  ];
}
