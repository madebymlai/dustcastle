# Deps Cache keyed on a Project Deps fingerprint, with loose repos cached

## Status

accepted — **supersedes [ADR 0012](0012-impure-cached-deps-unified-gc.md)'s** "a loose resolve has no stable key → never cached" clause. Refines [ADR 0013](0013-deps-cache-deep-module.md)'s Deps Cache module without changing the unified Store + deps-cache GC brain.

## Context

ADR 0012 deliberately cached assembled Project Deps only when a lockfile was present. A loose / lockless repo — for example `package.json` without `package-lock.json`, a hand-written unpinned `requirements.txt`, or an abstract `pyproject.toml` without a lock — always ran the full Package Manager install in every Sandbox because the resolve was not reproducible enough to key safely.

That protected freshness, but it is the wrong optimization for dustcastle's heavy-dependency loose repos. The practical pain is repeated sandbox startup latency: re-downloading packages and rebuilding native modules on every unchanged repo. Locked repos already get a warm restore that copies the assembled stage dir and skips install; loose repos need that same zero warm-start latency even if the restored result is a frozen first resolve rather than a fresh one.

The deps-cache key also had a latent locked-repo correctness hole: a lockfile-only key could collide across Toolchain versions or Package Managers and restore native deps built for the wrong runtime / manager.

## Decision

**Cache every detected Ecosystem's assembled Project Deps, lockfile or not, under a Project Deps fingerprint.**

- **Fingerprint inputs.** The deps-cache key is a hash of every dependency-determining file **present** for the Ecosystem — `present(manifests ∪ lockfiles)`, de-duplicated in declared order — plus the resolved **Toolchain version**, **Package Manager**, and **Ecosystem**. The key is over file contents and dispatch metadata, not a repo commit or unrelated files. If a path appears in both manifest and lockfile declarations, it is hashed once.
- **No uncacheable loose branch.** A loose / no-lockfile detection remains informational, but it no longer gates cacheability. `depsCacheKey` is a fingerprint, not a lockfile hash, and every detected Ecosystem can produce one.
- **Warm hit skips install.** On a cache hit, dustcastle restores the assembled stage dir (`node_modules` / `site` / `vendor`) from the host-owned Deps Cache before the Sandbox starts and emits no Package Manager install for that Ecosystem.
- **Miss installs; success populates.** On a miss, the Sandbox runs the normal in-Sandbox install. A successful install then populates the Deps Cache with the assembled stage dir.
- **Failed installs are never cached.** Populate is conditional on install success; partial or poisoned stage dirs are not frozen into the cache, so a later run can self-heal by reinstalling.
- **Reproducibility / freshness is explicitly dropped.** For loose repos, the cache intentionally serves the first successful resolve for a fingerprint until a dependency-determining file changes or GC evicts the entry. "Never silently stale" is no longer a goal for this path; **zero warm-start latency for heavy-dependency loose repos is the sole target**.
- **Pre-warming is out of scope.** This ADR does not make the cold first run instant. It only makes the second and later runs on the same fingerprint restore instead of install.

## Considered Options

- **Keep ADR 0012's lockfile-only rule.** Freshest for loose repos, but preserves the worst user-visible latency: unchanged loose projects pay the full resolve + download + native build on every Sandbox. Rejected.
- **Manufacture or commit lockfiles for loose repos.** More reproducible, but changes user repos or adds a host-side pinning workflow that ADR 0012 deliberately removed. Rejected; dustcastle should not write project-local dependency policy.
- **Use Package Manager global stores / restore-keys and still run install.** Common CI pattern, but a warm start still invokes the Package Manager and may touch the network. Rejected because this ADR optimizes for no install command at all on a warm hit.
- **Prebuild / pre-warm fingerprints before the first Sandbox.** Would remove cold-start latency too, but requires a separate lifecycle and scheduling design. Deferred out of scope.

## Consequences

- **Loose repos become fast after the first successful install.** A manifest-only project gets the same warm copy path as a locked project.
- **Frozen restore is intentional.** A loose repo may keep using an older resolved dependency version even when the registry has newer matches for the same manifest. Freshness is recovered only when a manifest / lockfile input changes or the cache entry is evicted.
- **Fingerprint-keyed invalidation.** Edits to dependency-determining files produce a new fingerprint and therefore a fresh install; unrelated repo edits do not.
- **Cold first run only.** The install cost moves to the first run for a fingerprint; every warm hit restores the assembled stage dir and skips install.
- **Locked repos get a stricter key.** Folding Toolchain version, Package Manager, and Ecosystem into the fingerprint prevents wrong-ABI / wrong-manager restores that a lockfile-only key allowed.
- **GC and egress posture stay unchanged.** Entries age out through the existing deps-cache pool and unified GC brain. The standing Build Egress allowlist still governs only installs on cold misses; warm hits do not run the Package Manager.
