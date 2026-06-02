import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ecosystemFor, packageManagerDescriptor } from "../ecosystems/index.js";
import type { PackageManager } from "../ecosystems/index.js";

/**
 * Scoped network egress (ADR 0005 / 0010 / 0012). Egress is default-deny and always
 * an allowlist, never unrestricted internet. It is a STANDING allowlist that no
 * longer branches on build purity: every Sandbox installs deps with the network on
 * (the real Package Manager runs in-Sandbox via the sandcastle hook), so the registry
 * + git are always present. It is the union of two sources, kept distinct as
 * provenance for humans:
 *
 *  - **Build Egress** — every host each DETECTED Package Manager's install reaches
 *    (`registryHosts` on its descriptor — index + artifact/checksum hosts) + the repo's
 *    git host. A polyglot repo opens EVERY detected registry's hosts (Node + Python ⇒
 *    npm registry + pypi + the wheel CDN); the host set is the union, deduped.
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
   * The project directory (ADR 0012, dustcastle-61j). When given, the build allowlist
   * also opens the hosts of any git-sourced DEPENDENCIES — fetched from their own VCS
   * host (e.g. github.com), not the manager's registry. These are read GENERICALLY from
   * each detected manager's already-declared source files ({@link EcosystemDescriptor}
   * `manifests` ∪ {@link PackageManagerDescriptor} `lockfiles`), so a no-lockfile / loose
   * project is covered by its manifest. Omitted ⇒ no file I/O (deriveEgress stays pure).
   */
  readonly projectDir?: string;
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
 * and Agent Egress. Build Egress is the union of every detected manager's registry hosts
 * (`registryHosts`, required + non-empty on every descriptor), the hosts of any git-sourced
 * dependencies (scanned from the managers' declared source files when `projectDir` is given),
 * plus the repo's git host; Agent Egress is the model host(s), added whenever an agent will
 * run. No `impure` flag and no per-purity derivation — the allowlist is standing. Closed
 * (`none`) only when no manager is detected and no agent runs.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

// Build Egress (ADR 0012): the standing union of each detected manager's registry
// hosts (off its descriptor, exhaustive at tsc — every manager carries a non-empty
// registryHosts list of EVERY host its install reaches: index + artifact/checksum), the
// hosts of any git-sourced DEPENDENCIES (scanned generically from the manager's declared
// source files when projectDir is given), plus the repo's git host. Deduped and order-
// stable so a polyglot repo opens each registry's hosts once.
function buildEgressHosts(input: EgressInput): string[] {
  const hosts = input.packageManagers.flatMap((pm) => packageManagerDescriptor(pm).registryHosts);
  if (input.projectDir !== undefined) {
    for (const pm of input.packageManagers) hosts.push(...gitDepHosts(input.projectDir, pm));
  }
  const gitRemoteHost = input.gitRemoteHost;
  if (gitRemoteHost !== undefined && gitRemoteHost.length > 0) hosts.push(gitRemoteHost);
  return uniqueHosts(hosts);
}

/**
 * Hosts of git-sourced dependencies for one manager (ADR 0012, dustcastle-61j). A git
 * dep fetches from its OWN VCS host (github.com, a self-hosted GitLab, …), which the
 * registry allowlist can't know. Rather than a hand-written parser per lockfile format,
 * scan the manager's ALREADY-DECLARED source files — the ecosystem's `manifests` (always
 * present, even for a loose / no-lockfile project) ∪ the manager's `lockfiles` — for VCS
 * URLs, which are written the same way everywhere: `git+<scheme>://`, `ssh://`, `git://`,
 * scp `git@host:`, and the `github:`/`gitlab:`/`bitbucket:` shorthands. Deliberately NOT
 * bare `https://` — that also names registry indexes (cargo's `registry+https://…/
 * crates.io-index`), which are not dep hosts. Best-effort: an absent/unreadable file
 * contributes nothing. Adding an Ecosystem gets this for free once it declares its files.
 */
function gitDepHosts(projectDir: string, pm: PackageManager): string[] {
  const descriptor = packageManagerDescriptor(pm);
  const files = [...ecosystemFor(descriptor.ecosystem).manifests, ...descriptor.lockfiles];
  const hosts = new Set<string>();
  for (const name of files) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf8");
    } catch {
      continue; // absent / binary / unreadable → nothing to scan
    }
    // git+<scheme>://…, ssh://…, git://…, scp git@host:… — strip an optional `git+`
    // prefix, then reuse the repo-remote parser to pull the host (handles URL + scp).
    for (const match of text.matchAll(/(?:git\+[a-z0-9]+:\/\/|git:\/\/|ssh:\/\/|git@)[^\s"'`,)\]}<>]+/gi)) {
      const host = parseGitRemoteHost(match[0].replace(/^git\+/i, ""));
      if (host !== undefined && host.length > 0) hosts.add(host);
    }
    // Forge shorthands (npm package.json: "dep": "github:org/repo").
    for (const match of text.matchAll(/\b(github|gitlab|bitbucket):[\w.-]+\/[\w.-]+/gi)) {
      const forge = match[1]!.toLowerCase();
      hosts.add(forge === "github" ? "github.com" : forge === "gitlab" ? "gitlab.com" : "bitbucket.org");
    }
  }
  return [...hosts];
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
