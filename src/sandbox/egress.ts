import { packageManagerDescriptor } from "../ecosystems/index.js";
import type { PackageManager } from "../ecosystems/index.js";

/**
 * Scoped network egress (ADR 0005 / 0010). Egress is default-deny and always an
 * allowlist, never unrestricted internet. It is the union of two independently-
 * derived sources, kept distinct so a reader never mistakes "has an allowlist" for
 * "impure build":
 *
 *  - **Build Egress** — the registry/index the package manager names + derived git
 *    hosts, DERIVED from detection/manifest content (ADR 0005's "derived, not
 *    declared"). Present on impure runtime installs and on explicit online pin or
 *    pre-Sandbox fetch phases; a pure runtime build's deps are pre-assembled
 *    offline.
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

export interface EgressInput {
  /**
   * The detected Package Manager (names its registry). The closed Registry union,
   * not a free string: the registry host is derived from the manager's descriptor
   * ({@link packageManagerDescriptor}), so a half-added manager fails at `tsc`
   * rather than silently reaching no registry (architecture review candidate 1).
   */
  readonly packageManager: PackageManager;
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

const SCP_STYLE_GIT_REMOTE = /^(?:[^@/]+@)?([^/:]+):/;

/**
 * Derive the egress decision (ADR 0005 / 0010) as the union of Build Egress and
 * Agent Egress. Build Egress opens only for an impure runtime install: the
 * registry the manager's descriptor names ({@link PackageManager} → `registryHost`)
 * plus the repo's git host. A pure build needs none — its Project Deps are
 * pre-assembled offline in the Store. Agent Egress is the model host, added whenever
 * an agent will run regardless of purity. Closed (`none`) only when neither source
 * contributes a host — a pure Sandbox build with no agent.
 *
 * The host-side loose-pin resolve and the Cargo vendor FOD reach the network OUTSIDE
 * this allowlist by design (ADR 0005 amendment dustcastle-4ky): the resolve runs as a
 * trusted host subprocess under a deny-by-default env floor, and the vendor fetch is a
 * hash-pinned Nix FOD. So neither is a `buildPhase` here — this derives the Sandbox
 * proxy's allowlist only.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

// Build Egress (ADR 0005): only an impure runtime install opens the network. The
// registry comes off the manager's descriptor (exhaustive at tsc); the repo's git
// host rides along for git-sourced deps. A pure build reaches nothing.
function buildEgressHosts(input: EgressInput): string[] {
  if (!input.impure) return [];
  const registry = packageManagerDescriptor(input.packageManager).registryHost;
  if (registry === undefined) return [];

  const hosts = [registry];
  const gitRemoteHost = input.gitRemoteHost;
  if (gitRemoteHost !== undefined && gitRemoteHost.length > 0) hosts.push(gitRemoteHost);
  return uniqueHosts(hosts);
}

/**
 * The deduped, order-stable allowlist the filtering proxy enforces: Build Egress
 * hosts first, then Agent Egress. The proxy consumes only this flat union — the
 * build/agent provenance on {@link EgressDecision} is for humans and the CLI.
 */
export function egressHosts(decision: EgressDecision): string[] {
  if (decision.kind === "none") return [];
  return uniqueHosts([...decision.buildHosts, ...decision.agentHosts]);
}

/**
 * Extract the host from a git remote URL — scp-style (`git@host:org/repo`),
 * `ssh://`, `https://`, etc. Returns undefined when no host can be read.
 */
export function parseGitRemoteHost(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (url.length === 0) return undefined;

  // scp-style: user@host:path (no scheme, a colon before the path, no "//").
  const scpHost = parseScpStyleGitHost(url);
  if (scpHost !== undefined && !url.includes("://")) return scpHost;

  // Scheme URLs: ssh://, https://, git://, …
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function parseScpStyleGitHost(remoteUrl: string): string | undefined {
  return SCP_STYLE_GIT_REMOTE.exec(remoteUrl)?.[1];
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}
