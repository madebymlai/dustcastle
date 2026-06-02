import { spawnSync } from "node:child_process";
import { packageManagerDescriptor } from "../ecosystems/index.js";
import type { PackageManager } from "../ecosystems/index.js";

/**
 * Scoped network egress (ADR 0005 / 0010 / 0012). Egress is default-deny and always
 * an allowlist, never unrestricted internet. It is a STANDING allowlist that no
 * longer branches on build purity: every Sandbox installs deps with the network on
 * (the real Package Manager runs in-Sandbox via the sandcastle hook), so the registry
 * + git are always present. It is the union of two sources, kept distinct as
 * provenance for humans:
 *
 *  - **Build Egress** — the registry/index each DETECTED Package Manager names
 *    (`registryHost` on its descriptor) + the repo's git host. A polyglot repo opens
 *    EVERY detected registry (Node + Python ⇒ npm registry + pypi); the host set is
 *    the union, deduped.
 *  - **Agent Egress** — the coding agent's own model-provider API host (ADR 0010).
 *    Present whenever an agent will run.
 *
 * Closed (`none`) only when neither source contributes a host — no Ecosystem detected
 * and no agent. The filtering proxy sees only the deduped union ({@link egressHosts})
 * — the build/agent split is provenance for humans (and the CLI), not something the
 * proxy consumes.
 */

export type EgressDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "allowlist";
      /** Hosts the *build* needs (each detected manager's registry + git). */
      readonly buildHosts: readonly string[];
      /** The *agent's* model-provider API host(s) (ADR 0010). */
      readonly agentHosts: readonly string[];
    };

export interface EgressInput {
  /**
   * The DETECTED Package Managers (each names its registry). The closed Registry
   * union, not free strings: each registry host is derived from the manager's
   * descriptor ({@link packageManagerDescriptor}), so a half-added manager fails at
   * `tsc` rather than silently reaching no registry. A polyglot repo surfaces several
   * (Node + Python), so this is a set and the allowlist is their union.
   */
  readonly packageManagers: readonly PackageManager[];
  /** The repo's git remote host, when known (for git-sourced deps). */
  readonly gitRemoteHost?: string;
  /**
   * The agent's model-provider API host(s), when an agent will run (ADR 0010 —
   * Agent Egress). A provider may span several hosts (auth refresh, regional
   * endpoint), so this is a list.
   */
  readonly agentModelHosts?: readonly string[];
}

const SCP_STYLE_GIT_REMOTE = /^(?:[^@/]+@)?([^/:]+):/;

/**
 * Derive the egress decision (ADR 0005 / 0010 / 0012) as the union of Build Egress
 * and Agent Egress. Build Egress is the union of every detected manager's registry
 * (`registryHost`, required on every descriptor) plus the repo's git host; Agent
 * Egress is the model host(s), added whenever an agent will run. No `impure` flag and
 * no per-purity derivation — the allowlist is standing. Closed (`none`) only when no
 * manager is detected and no agent runs.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

// Build Egress (ADR 0012): the standing union of each detected manager's registry
// (off its descriptor, exhaustive at tsc — every manager carries a registryHost) plus
// the repo's git host for git-sourced deps. Deduped and order-stable so a polyglot
// repo opens both registries once.
function buildEgressHosts(input: EgressInput): string[] {
  const hosts = input.packageManagers.map((pm) => packageManagerDescriptor(pm).registryHost);
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

/**
 * Read the repo's git remote host (origin) for the standing egress allowlist
 * (ADR 0005/0012 — git-sourced deps resolve). Undefined when there is no origin
 * remote (or git is unavailable) — the build still opens the registry, just not git.
 */
export function gitRemoteHost(cwd: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseGitRemoteHost(result.stdout.trim());
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}
