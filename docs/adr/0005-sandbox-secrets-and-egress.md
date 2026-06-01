# Sandbox access: default-deny on secrets, scoped egress

An autonomous agent — and any third-party code it runs (a build, a test, an impure `postinstall`) — executes inside the Sandbox. The container Boundary ([ADR 0003](0003-container-boundary-for-v1.md)) stops the agent damaging the *host*, but "safe to point at my work repos" is decided by **what the Sandbox can reach**. We make that **default-deny**.

This ADR is what makes the `allow`-by-default impurity policy ([ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)) safe: lax-on-purity is acceptable *because* we are strict-on-access.

## Decisions

1. **No host credentials by default.** The Sandbox does **not** inherit host secrets — `~/.ssh`, cloud credentials, `.npmrc`/registry tokens, or the host's ambient environment variables. Secrets are injected only when **explicitly declared**, scoped to what a build/test needs, and ideally short-lived. Default-deny, opt-in per secret. **The explicit channel is the environment / an external secret-store reference — never a dustcastle config file** (dustcastle is config-less; you'd never commit a token to a repo file anyway). Secret *injection* is the one irreducibly-explicit input, but "explicit" means env/secret-store, consistent with the no-configs interface.

2. **Scoped network egress.** Egress is **not** unrestricted internet by default. At minimum it is *known*; the target is an **allowlist** (package registries + the git host the project needs). This matters most precisely because impure `allow` mode runs untrusted `postinstall` code *with* network — an allowlist turns "a compromised dep can exfiltrate anywhere" into "it can reach the registries it was going to anyway." **The allowlist is *derived from ecosystem detection*, not declared** ([ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md)): detecting npm/pip/cargo already names the registry (registry.npmjs.org / pypi.org / crates.io), and the git remote is read from the repo — so the common case needs no configuration at all.

3. **The worktree is the writable blast radius.** The agent writes only the mounted worktree; the Store is read-only; the rest of the host is untouched. Branch strategy governs whether changes reach a real branch.

## Why

The realistic work risk is not the agent kernel-escaping (trusted agent, container boundary) — it is **credential exfiltration**, by the agent or by a supply-chain-compromised dependency. A sandbox that silently inherits your SSH keys, cloud creds, and full network is the actual danger, far more than non-reproducible `node_modules`. Default-deny on access neutralises the worst case and is what lets [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md) be permissive about impurity.

## Considered Options

- **Inherit the host environment / mount `~`.** Convenient, zero-config — and exactly the exfiltration exposure. Rejected as default.
- **Unrestricted egress.** Simplest; lets any build "just work." Rejected as default — it makes impure third-party code a free exfiltration channel. Available as an explicit opt-in per project.

## Consequences

- Builds/tests needing a private registry or a real credential require **explicit, scoped injection** — a little more setup, in exchange for a sandbox that can't leak your work secrets.
- The egress allowlist needs per-Ecosystem maintenance (registry/proxy hosts) — overlaps with the curated-override and ecosystem-detection work.
- Pure-mode builds ([ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)) run with no network at all, so they are unaffected by egress policy — another reason pure is the safer default.

## Amendment: the host-side loose-pin resolve (dustcastle-4ky)

Pin-then-pure ([ADR 0006c](0006-ecosystem-detection-owned-lockfile-router.md)) resolves a loose manifest **once** on the host, before any Sandbox exists — e.g. `cargo generate-lockfile` for a `Cargo.toml` with no `Cargo.lock`. This is the one place dustcastle reaches the network *outside* the Sandbox egress proxy, so it warrants an explicit decision rather than an implicit exception.

- **Not proxy-confined, by design.** The egress proxy ([ADR 0011](0011-production-egress-proxy-container.md)) confines the Sandbox *container's* network; the loose-pin runs as a trusted host subprocess and is not a container on that network. More importantly, the threat the proxy addresses — *untrusted third-party code* (`postinstall`, `build.rs`, proc-macros) exfiltrating over the network — is **absent here**: a lockfile resolve reads only package-index metadata and runs **no** dependency code. Containerizing it behind the proxy would add real complexity for a threat this step does not carry.
- **Still default-deny on secrets (decision 1).** The resolve inherits **no ambient host secrets**. Its environment is a deny-by-default allowlist — only the TLS trust roots, toolchain (rustup), locale, and outbound-proxy variables cargo needs to read the sparse index — plus an isolated, throwaway `CARGO_HOME`. Host credentials (`~/.ssh`, cloud creds, registry tokens, arbitrary env) never reach it.
- **Network posture.** The resolve reaches the package index over the host network (for cargo, the crates.io sparse index). This is narrow by construction — the trusted package manager fetching the metadata it was always going to fetch — and produces a single visible, committed lockfile, after which every build runs pure/offline under the full egress policy above.

Consequence: the "no unconfined network" invariant is precise — it governs the **Sandbox**. The pre-Sandbox loose-pin is a trusted, secret-free, metadata-only host resolve, scoped at the environment rather than by the proxy.
