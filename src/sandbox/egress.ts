/**
 * Scoped network egress (ADR 0005 / 0010). Egress is default-deny and always an
 * allowlist, never unrestricted internet. It is the union of two independently-
 * derived sources, kept distinct so a reader never mistakes "has an allowlist" for
 * "impure build":
 *
 *  - **Build Egress** — the registry/index the package manager names + the repo's
 *    git host, DERIVED from detection (ADR 0005's "derived, not declared").
 *    Present on impure runtime installs and on explicit online pin phases; a pure
 *    runtime build's deps are pre-assembled offline.
 *  - **Agent Egress** — the coding agent's own model-provider API host (ADR 0010).
 *    Present whenever an agent will run, REGARDLESS of build purity: the agent
 *    must reach its LLM even when the build itself reaches nothing it would use.
 *
 * A pure build with no agent reaches nothing at all (`none`). The filtering proxy
 * sees only the deduped union ({@link egressHosts}) — the build/agent split is
 * provenance for humans (and the CLI), not something the proxy consumes.
 */
export type EgressDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "allowlist";
      /** Hosts the *build* needs (registry/index + git) for the scoped phase. */
      readonly buildHosts: readonly string[];
      /** The *agent's* model-provider API host(s) (ADR 0010). */
      readonly agentHosts: readonly string[];
    };

export type BuildEgressPhase = "runtime" | "lockOnlyResolve";

export interface EgressInput {
  /** The detected package manager (names its registry). */
  readonly packageManager: string;
  /** Whether this build runs impurely (untrusted install code with network). */
  readonly impure: boolean;
  /**
   * Which build-side network phase is being scoped. The default runtime phase only
   * opens Build Egress for impure installs; lockOnlyResolve is the one-time
   * pin-then-pure resolve for loose manifests (online, but not an impure install).
   */
  readonly buildPhase?: BuildEgressPhase;
  /** The repo's git remote host, when known (for git-sourced deps). */
  readonly gitRemoteHost?: string;
  /**
   * The agent's model-provider API host(s), when an agent will run (ADR 0010 —
   * Agent Egress). Added to the allowlist regardless of build purity, so even a
   * pure, offline build can let the in-sandbox agent reach its LLM. A provider may
   * span several hosts (auth refresh, regional endpoint), so this is a list.
   */
  readonly agentModelHosts?: readonly string[];
}

/** Package manager → the registry host it fetches from (ADR 0005). */
const REGISTRY_HOSTS: Readonly<Record<string, string>> = {
  npm: "registry.npmjs.org",
  pnpm: "registry.npmjs.org",
  bun: "registry.npmjs.org",
  yarn: "registry.yarnpkg.com",
  pip: "pypi.org",
};

const LOCK_ONLY_RESOLVE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  npm: ["registry.npmjs.org"],
  pnpm: ["registry.npmjs.org"],
  pip: ["pypi.org"],
  // `cargo generate-lockfile` reads package metadata/checksums from the sparse
  // index, but downloads no crate tarballs, so static.crates.io is deliberately
  // absent (dustcastle-gy5.4).
  cargo: ["index.crates.io"],
};

/**
 * Derive the egress decision (ADR 0005 / 0010) as the union of Build Egress and
 * Agent Egress. Runtime Build Egress opens only for impure installs: the registry
 * the manager already uses plus the repo's git host — turning "a compromised dep
 * can exfiltrate anywhere" into "it can reach the registries it was going to
 * anyway." Lock-only resolve phases can also request their minimal online index.
 * Agent Egress is the model host, added whenever an agent will run regardless of purity.
 * Closed (`none`) only when neither source contributes a host — a pure build with
 * no agent.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

function buildEgressHosts(input: EgressInput): string[] {
  const hosts = phaseBuildHosts(input);
  if (hosts.length === 0) return hosts;

  const gitRemoteHost = input.gitRemoteHost;
  if (gitRemoteHost !== undefined && gitRemoteHost.length > 0) hosts.push(gitRemoteHost);
  return hosts;
}

function phaseBuildHosts(input: EgressInput): string[] {
  switch (input.buildPhase ?? "runtime") {
    case "lockOnlyResolve":
      return [...(LOCK_ONLY_RESOLVE_HOSTS[input.packageManager] ?? [])];
    case "runtime":
      return runtimeBuildHosts(input);
  }
}

function runtimeBuildHosts(input: EgressInput): string[] {
  if (!input.impure) return [];
  const registry = REGISTRY_HOSTS[input.packageManager];
  return registry === undefined ? [] : [registry];
}

/**
 * The deduped, order-stable allowlist the filtering proxy enforces: Build Egress
 * hosts first, then Agent Egress. The proxy consumes only this flat union — the
 * build/agent provenance on {@link EgressDecision} is for humans and the CLI.
 */
export function egressHosts(decision: EgressDecision): string[] {
  if (decision.kind === "none") return [];
  return [...new Set([...decision.buildHosts, ...decision.agentHosts])];
}

/**
 * Extract the host from a git remote URL — scp-style (`git@host:org/repo`),
 * `ssh://`, `https://`, etc. Returns undefined when no host can be read.
 */
export function parseGitRemoteHost(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (url.length === 0) return undefined;

  // scp-style: user@host:path (no scheme, a colon before the path, no "//").
  const scp = url.match(/^(?:[^@/]+@)?([^/:]+):/);
  if (scp && !url.includes("://")) return scp[1];

  // Scheme URLs: ssh://, https://, git://, …
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}
