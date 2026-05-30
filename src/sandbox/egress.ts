/**
 * Scoped network egress (ADR 0005). Egress is default-deny: a pure build reaches
 * no network at all, and the impure `allow` path — which runs untrusted
 * `postinstall` code *with* network — gets an **allowlist derived from
 * detection**, not unrestricted internet. Detecting the package manager already
 * names its registry; the git host is read from the repo. The common case needs
 * no configuration (ADR 0005's "derived, not declared").
 */
export type EgressDecision =
  | { readonly kind: "none" }
  | { readonly kind: "allowlist"; readonly hosts: readonly string[] };

export interface EgressInput {
  /** The detected package manager (names its registry). */
  readonly packageManager: string;
  /** Whether this build runs impurely (untrusted install code with network). */
  readonly impure: boolean;
  /** The repo's git remote host, when known (for git-sourced deps). */
  readonly gitRemoteHost?: string;
}

/** Package manager → the registry host it fetches from (ADR 0005). */
const REGISTRY_HOSTS: Readonly<Record<string, string>> = {
  npm: "registry.npmjs.org",
  pnpm: "registry.npmjs.org",
  bun: "registry.npmjs.org",
  yarn: "registry.yarnpkg.com",
};

/**
 * Derive the egress decision (ADR 0005). Pure → closed; impure → an allowlist of
 * the registry the manager already uses plus the repo's git host. This turns "a
 * compromised dep can exfiltrate anywhere" into "it can reach the registries it
 * was going to anyway."
 */
export function deriveEgress(input: EgressInput): EgressDecision {
  if (!input.impure) return { kind: "none" };

  const hosts: string[] = [];
  const registry = REGISTRY_HOSTS[input.packageManager];
  if (registry !== undefined) hosts.push(registry);
  if (input.gitRemoteHost !== undefined && input.gitRemoteHost.length > 0) {
    hosts.push(input.gitRemoteHost);
  }
  return { kind: "allowlist", hosts };
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
