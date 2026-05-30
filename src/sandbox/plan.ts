import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import type { Detection } from "../detect/index.js";
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
   * The URL of the running egress proxy to route the container's tooling through
   * (ADR 0005). Only used on the allowlist path. Defaults to the production proxy
   * container's name on the internal egress net; the live e2e overrides it with
   * its host-side proxy address.
   */
  readonly proxyUrl?: string;
  /** Base image; a stock image suffices — the Nix closure carries its own libc. */
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

/** A stock base image works — the Nix closure carries its own glibc/std (ADR 0008). */
const DEFAULT_IMAGE = "docker.io/library/debian:bookworm";

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

  return { podmanOptions, setupCommands: setupFor(detection, provisioned, egress), egress };
}

/** The run environment per ecosystem: Toolchain on PATH + writable caches off the RO Store. */
function envFor(ecosystem: Detection["ecosystem"], toolchainStorePath: string): Record<string, string> {
  const bin = `${toolchainStorePath}/bin`;
  if (ecosystem === "node") {
    return {
      PATH: `${bin}:/usr/bin:/bin`,
      // The Store is read-only; npm's cache + home must point somewhere writable.
      NPM_CONFIG_CACHE: "/tmp/npm-cache",
      XDG_CACHE_HOME: "/tmp/.cache",
      npm_config_update_notifier: "false",
    };
  }
  if (ecosystem === "python") {
    // Python (pip-FOD): the python Toolchain (with pip) on PATH; the offline-
    // assembled site-packages are staged into ./site (see setupFor) and reached
    // via PYTHONPATH. The Store is read-only, so pip's cache points to /tmp.
    return {
      PATH: `${bin}:/usr/bin:/bin`,
      PYTHONPATH: "site",
      PIP_CACHE_DIR: "/tmp/pip-cache",
      XDG_CACHE_HOME: "/tmp/.cache",
    };
  }
  // Go (spike-proven): vendored deps, proxy off, writable build cache.
  return {
    PATH: `${bin}:/usr/bin:/bin`,
    GOFLAGS: "-mod=vendor",
    GOPROXY: "off",
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
    GOCACHE: "/tmp/gocache",
    GOENV: "off",
  };
}

/**
 * The container-side install for an impure `allow` JS build, per package manager
 * (ADR 0004/0005). The deps weren't pre-built in the Store, so the real install —
 * lifecycle scripts included — runs in the container under scoped egress. Each
 * manager installs strictly from its committed lockfile (frozen/immutable) so the
 * impure build still can't silently drift from the pinned deps.
 */
const IMPURE_INSTALL: Readonly<Record<string, string>> = {
  npm: "npm ci",
  pnpm: "pnpm install --frozen-lockfile",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
};

/** The per-project sandbox-ready setup: stage deps from the Store, or install impurely. */
function setupFor(detection: Detection, provisioned: Provisioned, egress: EgressDecision): string[] {
  if (detection.ecosystem === "node") {
    if (egress.kind === "allowlist") {
      // Impure `allow`: install in the container (lifecycle scripts included)
      // under the scoped egress network, with the manager that signalled. This is
      // where untrusted postinstall actually runs.
      return [IMPURE_INSTALL[detection.packageManager] ?? "npm ci"];
    }
    // Pure: copy the offline-assembled node_modules out of the read-only Store.
    // Manager-agnostic — every JS importer publishes the same node_modules layout.
    return [`cp -RL ${provisioned.depsStorePath}/node_modules node_modules`, "chmod -R u+w node_modules"];
  }
  if (detection.ecosystem === "python") {
    // Python (pip-FOD): copy the offline-assembled site-packages out of the
    // read-only Store into ./site (PYTHONPATH points there). The pip-FOD's deps
    // derivation publishes them under `$out/site`.
    return [`cp -RL ${provisioned.depsStorePath}/site site`, "chmod -R u+w site"];
  }
  // Go: stage the vendored modules from the Store into the worktree as vendor/.
  return [`cp -rL ${provisioned.depsStorePath} vendor`, "chmod -R u+w vendor"];
}
