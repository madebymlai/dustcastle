/**
 * Scoped network egress (ADR 0005 / 0010). Egress is default-deny and always an
 * allowlist, never unrestricted internet. It is the union of two independently-
 * derived sources, kept distinct so a reader never mistakes "has an allowlist" for
 * "impure build":
 *
 *  - **Build Egress** — the registry the package manager names + the repo's git
 *    host, DERIVED from detection/manifest content (ADR 0005's "derived, not
 *    declared"). Present on impure installs and on explicit pre-Sandbox fetch
 *    phases (for example Cargo's vendor FOD); ordinary pure Sandbox builds stay
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
  /**
   * Network-using build phase, when the build is pure from the Sandbox's point of
   * view but a pre-Sandbox fetch step still needs scoped Build Egress. Cargo's
   * vendor FOD is the first such phase: it fetches crates into the Store, then the
   * Sandbox itself remains offline.
   */
  readonly buildPhase?: "cargo-vendor";
  /** Cargo.toml contents used to derive git dependency hosts for Cargo Build Egress. */
  readonly cargoManifest?: string;
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

const CARGO_VENDOR_HOSTS = ["index.crates.io", "static.crates.io"] as const;

/**
 * Derive the egress decision (ADR 0005 / 0010) as the union of Build Egress and
 * Agent Egress. Build Egress is either the registry the impure manager already
 * uses plus the repo's git host, or an explicit pre-Sandbox fetch phase such as
 * Cargo's vendor FOD (`index.crates.io` + `static.crates.io` + manifest git dep
 * hosts). Agent Egress is the model host, added whenever an agent will run
 * regardless of purity. Closed (`none`) only when neither source contributes a
 * host — a pure Sandbox build with no agent.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts: string[] = [];
  if (input.buildPhase === "cargo-vendor") {
    buildHosts.push(...CARGO_VENDOR_HOSTS, ...cargoGitDependencyHosts(input.cargoManifest ?? ""));
  } else if (input.impure) {
    const registry = REGISTRY_HOSTS[input.packageManager];
    if (registry !== undefined) buildHosts.push(registry);
    if (input.gitRemoteHost !== undefined && input.gitRemoteHost.length > 0) {
      buildHosts.push(input.gitRemoteHost);
    }
  }

  const agentHosts: string[] = (input.agentModelHosts ?? []).filter((h) => h.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts: [...new Set(buildHosts)], agentHosts };
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

/** Derive host:port entries from Cargo.toml `git = "…"` dependency references. */
export function cargoGitDependencyHosts(cargoManifest: string): string[] {
  const hosts: string[] = [];
  const gitAttr = /\bgit\s*=\s*(["'])(.*?)\1/g;

  for (const rawLine of cargoManifest.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    for (const match of line.matchAll(gitAttr)) {
      const host = gitUrlHostPort(match[2] ?? "");
      if (host !== undefined) hosts.push(host);
    }
  }

  return [...new Set(hosts)];
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if ((c === '"' || c === "'") && line[i - 1] !== "\\") {
      quote = quote === c ? undefined : quote ?? c;
    }
    if (c === "#" && quote === undefined) return line.slice(0, i);
  }
  return line;
}

function gitUrlHostPort(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (url.length === 0) return undefined;

  const scp = url.match(/^(?:[^@/]+@)?([^/:]+):/);
  if (scp && !url.includes("://")) return `${scp[1]}:22`;

  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.length === 0) return undefined;
    const port = parsed.port || defaultGitPort(parsed.protocol);
    return port === undefined ? host : `${host}:${port}`;
  } catch {
    const host = parseGitRemoteHost(url);
    return host === undefined ? undefined : `${host}:443`;
  }
}

function defaultGitPort(protocol: string): string | undefined {
  switch (protocol) {
    case "http:":
      return "80";
    case "https:":
      return "443";
    case "ssh:":
      return "22";
    case "git:":
      return "9418";
    default:
      return undefined;
  }
}
