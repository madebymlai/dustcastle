# Ecosystem detection: an owned lockfile router, pin loose manifests to pure

dustcastle decides which [Ecosystem](../../CONTEXT.md) a repo is — and therefore which Nix importer to run ([ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)) — with **its own thin router over the repo's files**, not a third-party detector. The router reads two signals: the **lockfile** (which names both the ecosystem *and* the package manager) and the **toolchain-version files** (`.nvmrc`, `.python-version`, `go.mod`'s `go 1.22`, …). When a manifest is not lock-grade, dustcastle **pins it once into a generated lock, then builds purely** — rather than going impure.

## Why own it (and not pair with a tool)

We surveyed what exists for "point at a repo → auto-detect → build deps with Nix" (2026). The capability splits in two and **nothing mature spans both**:

- **Detection** is solved by reusable classifiers — **ORT** (20+ package managers, JVM library), **nixpacks** (Rust crate, knows pnpm/bun/yarn), **mise** (toolchain *versions* from idiomatic files) — but **none emit Nix**.
- **Nix dep build** (`uv2nix`, `npmlock2nix`, `crane`, `gomod2nix`, dream2nix) is mature per-ecosystem but **every importer assumes the caller already named the ecosystem**.

The dispatch glue between them is irreducibly dustcastle's. The two tools that *did* span both are dead ends: **nixpacks** is in maintenance mode and its successor **Railpack dropped Nix entirely** (Railway's own "Why We're Moving on From Nix"), and **dream2nix**'s auto-discovery regressed to manual module selection in its v1 rewrite. Taking either as a dependency would contradict [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)'s "own the engine, no heavyweight external dependency" — the same call we made choosing raw Nix over flox. The detection rules are simple enough (which lockfile is present) that a ~100-line owned router beats a heavy dependency.

A second, broader survey (minimal detectors + SBOM-grade lockfile parsers) confirmed this: **no small, permissively-licensed, cross-ecosystem detection library with the right output shape exists.** The tiny detectors (`package-manager-detector`/antfu, `preferred-pm`, `which-pm`) are **JS-only**; language classifiers (go-enry, linguist, tokei) detect *languages* not package managers; version-file tools (mise, asdf) detect *toolchain versions* and expose no reusable parser; and the SBOM/SCA engines (syft, trivy, OSV-Scalibr, cdxgen, ScanCode, ORT) cover everything but are heavyweight, emit SBOMs we'd have to post-process, and some (**cdxgen**) *execute build tools* as a side effect — unacceptable for mere routing. dustcastle only needs *detection + dispatch*, not a dep parser: the lang2nix importer (uv2nix, `fetchPnpmDeps`) parses the lockfile itself inside Nix.

**But we don't invent the rules — we borrow them.** The router seeds its lockfile→manager mapping from OSV-Scanner/OSV-Scalibr's authoritative supported-lockfiles map (the most complete, current cross-ecosystem table), and its precedence from Cloud Native Buildpacks / Paketo. Owning ~100 lines of dispatch is right; reinventing the *table* or the *tie-breaks* is not.

## How detection works

**(a) Lockfile → importer.** The lockfile, not the language, is the signal — it uniquely identifies the package manager, which is what selects the importer:

| File present | Pkg-mgr | → importer |
|---|---|---|
| `pnpm-lock.yaml` | pnpm | `fetchPnpmDeps` |
| `bun.lockb` | bun | bun importer |
| `yarn.lock` | yarn | yarn importer |
| `package-lock.json` | npm | `fetchNpmDeps` |
| `uv.lock` | uv | `uv2nix` |
| `poetry.lock` | poetry | `poetry2nix` |
| `Pipfile.lock` / `pdm.lock` | pipenv / pdm | matching importer |
| `Cargo.lock` | cargo | `crane` |
| `go.sum` / `go.mod` | go | `buildGoModule` |
| `Gemfile.lock` | bundler | `bundlerEnv` |

**(b) Toolchain version.** The lockfile doesn't say *which* runtime version. Honor the version-file *conventions* mise/asdf standardized — `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.tool-versions`, and `go.mod`'s `go` line — by **parsing the files**, not by depending on the mise binary.

**(c) Loose manifest → pin-then-pure.** A manifest without a lock-grade input (`requirements.txt`, `package.json` with no lockfile, bare `Gemfile`, abstract `pyproject.toml`) can't be fetched offline. Rather than go impure, dustcastle **resolves it once and hash-pins a generated lock** (a one-time *online resolve*, written as a visible, version-controlled artifact), then every build runs **pure/offline** against that lock. `requirements.txt` is the poster child — pinned-with-hashes is already lock-grade; pinned-without-hashes or unpinned gets pinned. This is strictly better than impurity: the resolve is a pinning step whose *output* is reproducible, it satisfies [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)'s "never silent" invariant, and it gives the repo a real lock it lacked. True impurity (`allow`/`ask`/`deny`) is the last resort, only when a dep genuinely can't be pinned.

**(d) Precedence + ambiguity** (the CNB/Paketo model — borrowed, not invented). **Ordered first-match-wins**, preferring **explicit signals over inferred** ones: a JS repo's `packageManager`/`devEngines` field beats its lockfile, a real lockfile beats a loose manifest (a repo with both `uv.lock` and `requirements.txt` uses uv), and the JS tie-break is `packageManager` field > `bun.lock`/`pnpm-lock.yaml`/`yarn.lock` > `package-lock.json`. Detection is **per-directory, not once at root**, so a polyglot/monorepo (`package.json` *and* `pyproject.toml`, or workspaces) detects *multiple* ecosystems and provisions each. The genuinely ambiguous case — `package.json` present only for a lint tool — is resolved by an **explicit override** in the project's dustcastle config.

## Considered Options

- **Adopt nixpacks / dream2nix discovery.** Off-the-shelf detection+Nix — rejected: nixpacks is abandonware whose creators left Nix; dream2nix discovery is legacy-branch-only and "unstable." Heavyweight dependency against ADR 0001's principle.
- **ORT / syft / trivy / cdxgen / ScanCode as the detection front-end.** Broad, battle-tested, Apache-2.0 — rejected as dependencies: heavyweight SCA/SBOM engines that emit SBOMs we'd post-process, drag large dep trees, and some (cdxgen) *execute build tools* as a side effect. We borrow their *data* (OSV-Scanner's lockfile→manager table), not their code.
- **OSV-Scalibr as an embedded library (Go).** The one option genuinely designed to embed, with extraction separable from vuln scanning and full ecosystem coverage. Held as an **escape hatch**, not the default: only worth it *if* dustcastle is written in Go *and* ever needs full parsed dependency lists — which it doesn't, because the lang2nix importer parses the lockfile inside Nix.
- **Tiny JS detectors (`package-manager-detector`, `preferred-pm`).** Clean and MIT — rejected as the base: JS-only, ~1 of ~10 ecosystems. May be reused for the JS sub-decision's fiddly tie-break if dustcastle is in Node.
- **Require explicit per-project ecosystem config.** Simplest to build — rejected as the default: contradicts the "agent configures nothing, all dynamic and works" promise. Kept only as the override escape hatch for ambiguity.
- **Treat loose manifests as impure.** Simpler than pinning — rejected as the default: throws away reproducibility we can cheaply recover by pinning once.

## Consequences

- Detection and the [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md) build read the **same artifact** (the lockfile), so the router and the importer fold together naturally.
- The pin-then-pure step needs a one-time network resolve per loose manifest — overlaps with the egress-allowlist work in [ADR 0005](0005-sandbox-secrets-and-egress.md).
- The importer table and version-file list need per-Ecosystem maintenance as package managers appear (a new JS package manager = one new row), but each addition is local and small.

## Amendment (2026-05-30): the Python Importer is a pip-FOD, not uv2nix/poetry2nix

The importer table above lists `uv.lock → uv2nix`, `poetry.lock → poetry2nix`, and section (c)
names `requirements.txt` the pin-then-pure poster child. For **Python**, those importer choices
are **superseded**. dustcastle's Python Importer is a single **pip fixed-output derivation
(pip-FOD)** — the direct `fetchNpmDeps` analogue:

- a network-enabled FOD runs `pip download --only-binary=:all: --require-hashes` (one aggregate
  output hash, discovered via the existing fake → mismatch → real probe), then a
  network-isolated step runs `pip install --no-index --find-links` to assemble the Project Deps
  offline. Wheels run no install-time code, so assembly is pure by construction.
- **uv and poetry are export front-ends to this one Importer** (`uv export` / `poetry export` →
  hash-pinned requirements), not separate importers. `requirements.txt` is consumed directly; a
  loose/unpinned manifest is resolved once via `uv pip compile --generate-hashes` — pin-then-pure
  (c) still holds, but the *pure build* is now a pip-FOD, not an eval-time per-package fetch.

**Why not uv2nix/poetry2nix.** Both are **external flake inputs** (not in nixpkgs), which would
break dustcastle's nixpkgs-via-`fetchTarball`-only invariant and contradict [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)'s
"own the engine, no heavyweight external dependency"; poetry2nix is additionally unmaintained.
The pip-FOD stays in nixpkgs, reuses the aggregate-hash machinery unchanged, and honours the
lockfile's own hashes. Validated end-to-end under nix-portable (spike laimk-hse.1, 2026-05-30):
discovery loop, network-in-FOD + cold toolchain fetch, offline install, and byte-reproducible
download all confirmed. A follow-up spike (laimk-hse.7, 2026-05-30) confirmed `poetry export`
is interchangeable with `uv export` as a pip-FOD input — its `--require-hashes` output is
`--only-binary=:all:`-clean and yields the *same* aggregate hash for the same deps — so poetry
provisions the pure path with no gate (the wheel+sdist hashes both front-ends emit are harmless:
the FOD downloads only the wheel and just needs its hash in the set).

**Hash field.** The pip-FOD has one discoverable aggregate hash, so `provisionStore`'s existing
Pass-1 discover / Pass-2 build loop and `outputHashField` are reused **unchanged**. `Provisioned`
gains a `pythonDepsHash` field and `OutputHashField` a matching `"pythonDepsHash"` variant (rather
than overloading `npmDepsHash`); no skip-discovery machinery is introduced.

**Carried caveat.** A wheel set is keyed by `(platform, python-version, abi)`; for native packages
the discovered hash is keyed per `(system, pythonVersion)` and `pip download` pins
`--platform/--python-version/--implementation/--abi`. Sdist-only / no-wheel packages hard-fail
under `--only-binary=:all:` and route to the impure container path ([ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)/[ADR 0005](0005-sandbox-secrets-and-egress.md)).
