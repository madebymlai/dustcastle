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

export type BuildEgressPhase = "runtime" | "lockOnlyResolve" | "cargo-vendor";

export interface EgressInput {
  /** The detected package manager (names its registry). */
  readonly packageManager: string;
  /** Whether this build runs impurely (untrusted install code with network). */
  readonly impure: boolean;
  /**
   * Which build-side network phase is being scoped. The default runtime phase only
   * opens Build Egress for impure installs; lockOnlyResolve is the one-time
   * pin-then-pure resolve for loose manifests (online, but not an impure install);
   * cargo-vendor fetches Cargo deps into the Store before the Sandbox stays offline.
   */
  readonly buildPhase?: BuildEgressPhase;
  /**
   * Cargo.lock contents used to derive git dependency hosts for Cargo Build Egress.
   * The lockfile is the resolved truth (`source = "git+…"`), so a transitive git dep
   * that never appears in the root Cargo.toml is still covered (dustcastle-gy5.5).
   */
  readonly cargoLock?: string;
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

const CARGO_VENDOR_HOSTS = ["index.crates.io", "static.crates.io"] as const;
const SCP_STYLE_GIT_REMOTE = /^(?:[^@/]+@)?([^/:]+):/;
// Cargo.lock records a git dependency's resolved origin as `source = "git+<url>…"`
// (registry deps use `registry+…`, which must NOT match — gy5.5 keeps the legacy
// `github.com/rust-lang/crates.io-index` host out of the allowlist).
const CARGO_LOCK_GIT_SOURCE = /\bsource\s*=\s*"git\+([^"]+)"/g;

/**
 * Derive the egress decision (ADR 0005 / 0010) as the union of Build Egress and
 * Agent Egress. Build Egress opens for impure runtime installs, for minimal
 * lock-only resolve phases, or for explicit pre-Sandbox fetch phases such as
 * Cargo's vendor FOD (`index.crates.io` + `static.crates.io` + manifest git dep
 * hosts). Agent Egress is the model host, added whenever an agent will run
 * regardless of purity. Closed (`none`) only when neither source contributes a
 * host — a pure Sandbox build with no agent.
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

function buildEgressHosts(input: EgressInput): string[] {
  if (input.buildPhase === "cargo-vendor") {
    return uniqueHosts([...CARGO_VENDOR_HOSTS, ...cargoGitDependencyHosts(input.cargoLock ?? "")]);
  }

  const hosts = phaseBuildHosts(input);
  if (hosts.length === 0) return hosts;

  const gitRemoteHost = input.gitRemoteHost;
  if (gitRemoteHost !== undefined && gitRemoteHost.length > 0) hosts.push(gitRemoteHost);
  return uniqueHosts(hosts);
}

function phaseBuildHosts(input: EgressInput): string[] {
  switch (input.buildPhase ?? "runtime") {
    case "lockOnlyResolve":
      return [...(LOCK_ONLY_RESOLVE_HOSTS[input.packageManager] ?? [])];
    case "runtime":
      return runtimeBuildHosts(input);
    case "cargo-vendor":
      return [...CARGO_VENDOR_HOSTS, ...cargoGitDependencyHosts(input.cargoLock ?? "")];
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

/**
 * Derive host:port entries from a Cargo.lock's `source = "git+…"` dependency
 * origins. The lockfile is the resolved truth, so this covers transitive git deps
 * that never appear in the root Cargo.toml; `git+https` with no explicit port
 * normalizes to `:443` (dustcastle-gy5.5).
 */
export function cargoGitDependencyHosts(cargoLock: string): string[] {
  const hosts: string[] = [];

  for (const match of cargoLock.matchAll(CARGO_LOCK_GIT_SOURCE)) {
    const host = gitDependencyHostWithPort(match[1] ?? "");
    if (host !== undefined) hosts.push(host);
  }

  return uniqueHosts(hosts);
}

// A Cargo.lock `git+` source is always a scheme URL (`git+https://…`, `git+ssh://…`),
// so the host comes straight from `new URL`, with the scheme's default port when none
// is explicit. (Scp-style `git@host:path` never appears in a lockfile source, so it is
// deliberately not handled here — unlike parseGitRemoteHost, which reads repo remotes.)
function gitDependencyHostWithPort(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (url.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host.length === 0) return undefined;
  const port = parsed.port || defaultGitPort(parsed.protocol);
  return port === undefined ? host : `${host}:${port}`;
}

function parseScpStyleGitHost(remoteUrl: string): string | undefined {
  return SCP_STYLE_GIT_REMOTE.exec(remoteUrl)?.[1];
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
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
