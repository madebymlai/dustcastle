# Impure cached Project Deps via the sandcastle hook, with one GC interface over Store + cache

## Status

accepted — **supersedes [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)** (pure-by-default + explicit-impurity → all-impure, no FOD) and **[ADR 0004a](0004a-cargo-deps-via-cargohash-fetchcargovendor.md)** (the cargo FOD). **Amends [ADR 0005](0005-sandbox-secrets-and-egress.md) / [ADR 0010](0010-agent-llm-egress.md)** (egress is a standing allowlist, no per-purity derivation), **[ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md)** (a Package Manager names an install command + registry, not an Importer; the bun gate is removed), and **[ADR 0007](0007-store-lifecycle-management.md)** (its Store GC generalizes into a reusable interface serving a second pool). Keeps [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md) (shared Store for the Toolchain), [ADR 0002](0002-consume-sandcastle-via-provider-factories.md) (sandcastle), [ADR 0009](0009-no-project-local-config.md) (strengthened — the impurity marker file is removed).

**Amendment (dustcastle-6ta):** the "frozen when a lockfile is present, resolving fallback when not" install contract is realised as a SINGLE resolving line per manager, not a frozen/resolving branch. The frozen variants (`npm ci`, `--frozen-lockfile`, `--require-hashes`) hard-fail without a lockfile, so a loose/lockless repo (a hand-written `requirements.txt` of bare names, a `package.json` with no lock) could not install at all. `npm install` / `pnpm install` / `pip install -r requirements.txt` honour a committed lockfile when present and resolve when not — `go mod download` / `cargo fetch` already had this shape. `detection.loose` no longer influences the install (it never did, which was the bug); it governs only cacheability (a loose resolve has no stable key → never cached).

**Pointer:** [ADR 0016](0016-deps-cache-project-fingerprint-loose-cache.md) supersedes the loose/no-lockfile "never cached" clause above with a Project Deps fingerprint key and cached loose repos.

## Context

The maintenance weight in `src/ecosystems` is the **Importer/FOD + impurity apparatus**: the per-Package-Manager Nix dep importers (`src/nix/*`), the impurity-prediction lock readers (`src/impurity/*`), the `impuritySignal`↔`impureInstall`↔`registryHost` biconditionals, the `allow/ask/deny` policy with its `.dustcastle/impure.json` marker, and the per-purity egress derivation. dustcastle's job is narrower than that machinery serves: **set up a sandbox for an agent on a repo, with no per-repo config.** We do not trade on hermetic, reproducible, offline-built deps (the trusted / own-repos threat model, ADR 0004's original framing).

A pure FOD gives a managed dep cache (warm read-only mounts, dedup, free GC via ADR 0007) but only for deps that build hermetically, and at the cost of the whole apparatus. The alternative — run the real Package Manager (full coverage, no apparatus) and **cache the assembled result** — was rejected earlier only because it implied a second pool to garbage-collect. That objection dissolves once GC is **one reusable interface over two pools**: `gc.ts` is already a pure decision brain behind an injected mechanism, so a second pool is a generalization, not new machinery.

The install itself needs no new execution path: dustcastle already runs per-project setup through sandcastle's `hooks.sandbox.onSandboxReady` (`src/sandbox/plan.ts`), and the egress proxy already routes in-Sandbox install traffic (`proxy.ts`/`confine.ts`).

## Decision

**Deps install impurely via the sandcastle hook, the assembled result is cached, and one GC interface manages the Store and the cache.**

- **No FOD.** A Package Manager descriptor carries an **install command** (one resolving line that installs from a committed lockfile when present and resolves when not — `npm install`, `pnpm install`, `go mod download`, `cargo fetch`, `pip install -r requirements.txt`) and the **registry host** it fetches from. `src/nix/*` (the dep Importers), `lockOnlyResolve`/pin-then-pure, and the `uv`/`poetry` export front-ends all delete. Nix remains only for **Toolchain** provisioning into the Store (ADR 0001).
- **Install runs in-Sandbox via `onSandboxReady`** (the existing `setupCommands` seam). On a **cache hit**, the hook copies the assembled deps from the cache into the Ecosystem's stage dir (`node_modules`/`site`/`vendor`) — no network. On a **cache miss**, it runs the install command, then populates the cache. Cache entries are keyed by lockfile hash.
- **Egress is a standing allowlist** `{registry, git host, model host}`, default-deny, always on. No `impure` boolean, no per-purity derivation; `deriveEgress` dedups those hosts. `registryHost` becomes a **required** descriptor field (go/cargo gain one). The proxy/allowlist mechanism (ADR 0005/0010/0011) is unchanged.
- **One GC interface over two pools** (generalizes ADR 0007). The pure brain — recency records `{key, lastUsedAt, bytes}`, the disk-derived ceiling, warm-set selection that never evicts an active root, the freed-bytes report — is pool-agnostic. Each pool supplies a mechanism: `measure` · `entries` · `pin`/`release` · `evict` · optional `optimise`. The **Store pool** (Toolchain) uses `nix-store --gc`/`--optimise`/gc-roots (today's code); the **deps-cache pool** uses lockfile-hash-keyed directories (`evict` = remove dir, no `optimise`). A live run pins **both** its Toolchain closure and its deps-cache entry, released on completion.
- **Delete the impurity apparatus:** `src/impurity/*`, `src/run/impurity.ts`, `impuritySignal`, the `allow/ask/deny` policy, `parseImpurityMode`, the `DUSTCASTLE_IMPURE`/`_HEADLESS` env, the `.dustcastle/impure.json` marker, the biconditional tests, and the pure/impure branching in `store` and `plan`. **Remove bun's gate** — bun installs impurely like any other manager.

## Considered Options

- **Pure-only (FOD-or-fail).** Managed cache + tightest egress (`{model host}`), but hard-fails the impure tail and keeps `src/nix/*`. Rejected: we don't trade on reproducibility/offline, and we want full coverage.
- **Pure-by-default + `allow/ask/deny` (status quo).** Covers the tail but carries the whole apparatus + a project-local marker. Rejected: that apparatus is the weight.
- **Pre-Sandbox build phase for the impure install** (so the agent Sandbox stays `{model host}` only). Rejected: a new execution path when sandcastle's `onSandboxReady` hook + the existing proxy already run and confine the in-Sandbox install. Accepted cost: the agent Sandbox's allowlist includes `{registry, git}`, not just `{model}`.

## Consequences

- **Full coverage.** Every repo provisions — `postinstall`-fetches-network, sdist-only, native builds, git deps, bun — because the real Package Manager runs. No hard-fail tail.
- **Smaller registry surface:** `src/nix/*` and `src/impurity/*` delete; a descriptor is an install command + a registry host + staging, close to CONTEXT.md's three-slot Ecosystem definition.
- **Speed:** repeated sandboxes on the same lockfile hit the cache (assembled deps copied in, install + native build skipped); a cold lockfile pays one install.
- **One thing to tend, not two:** the deps cache is GC'd by the same brain as the Store; the only new code is a pool mechanism + the interface seam.
- **Reproducibility is dropped** (cached deps are whatever the impure install produced; not byte-stable across machines/time) — acceptable under the trusted model and not a guarantee we offer.
- **Egress posture:** the agent Sandbox reaches `{registry, git, model}` (the price of in-Sandbox install) — still default-deny, never the open internet. The "a pure build reaches nothing" property retires. **Trusted threat model is load-bearing**; untrusted/arbitrary repos would require revisiting (the lost no-network-build defense + a shared-kernel container would push toward the microVM Boundary, ADR 0003).
- **Strengthens ADR 0009:** the `.dustcastle/impure.json` marker (the one project-local file dustcastle wrote) is gone; the deps cache lives under the global dustcastle home.
- **CONTEXT.md rewording (pending acceptance):** **Project Deps** ("Nix-built … impure only via an explicit, marked policy"), **Importer** (no longer a property of the Package Manager), **Egress**/**Build Egress** (no longer derived/conditional; standing), **Warm/cold** (now also the deps cache, not just Store closures), **Ecosystem Registry** ("the bun gate"). devenv was considered and rejected — it manages the Toolchain, not Project Deps, so it is orthogonal to this decision.
