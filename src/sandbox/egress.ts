/**
 * Scoped network egress (ADR 0005 / 0010). Egress is default-deny and always an
 * allowlist, never unrestricted internet. It is the union of two independently-
 * derived sources, kept distinct so a reader never mistakes "has an allowlist" for
 * "impure build":
 *
 *  - **Build Egress** — the registry the package manager names + the repo's git
 *    host, DERIVED from detection (ADR 0005's "derived, not declared"). Present
 *    only on an impure build; a pure build's deps are pre-assembled offline.
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
      /** Hosts the *build* needs (registry + git); impure-only (ADR 0005). */
      readonly buildHosts: readonly string[];
      /** The *agent's* model-provider API host(s) (ADR 0010). */
      readonly agentHosts: readonly string[];
    };

export interface EgressInput {
  /** The detected package manager (names its registry). */
  readonly packageManager: string;
  /** Whether this build runs impurely (untrusted install code with network). */
  readonly impure: boolean;
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

/**
 * Derive the egress decision (ADR 0005 / 0010) as the union of Build Egress and
 * Agent Egress. Build Egress (impure-only) is the registry the manager already
 * uses plus the repo's git host — turning "a compromised dep can exfiltrate
 * anywhere" into "it can reach the registries it was going to anyway." Agent
 * Egress is the model host, added whenever an agent will run regardless of purity.
 * Closed (`none`) only when neither source contributes a host — a pure build with
 * no agent.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts: string[] = [];
  if (input.impure) {
    const registry = REGISTRY_HOSTS[input.packageManager];
    if (registry !== undefined) buildHosts.push(registry);
    if (input.gitRemoteHost !== undefined && input.gitRemoteHost.length > 0) {
      buildHosts.push(input.gitRemoteHost);
    }
  }

  const agentHosts: string[] = (input.agentModelHosts ?? []).filter((h) => h.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
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
