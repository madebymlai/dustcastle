# Cargo Project Deps via `cargoHash`/`fetchCargoVendor`, not `cargoLock`/`importCargoLock`

For the Rust Ecosystem's Cargo Package Manager, dustcastle vendors Project Deps with nixpkgs' `rustPlatform.fetchCargoVendor` and pins that fixed-output derivation with one aggregate `cargoHash`. We deliberately do **not** use the `cargoLock` / `importCargoLock` path in our Importer, even though that is the common in-repo Rust-on-Nix recommendation.

This is an amendment in the [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md) family: it decides how Cargo implements the same pure-by-default, hash-pinned Project Deps contract.

## Why the aggregate hash is load-bearing

The Store provisioner has one uniform two-pass flow for pure Project Deps:

1. emit the Importer's Nix expression with a fake hash;
2. let the Nix fixed-output derivation fail;
3. parse the `got: sha256-…` mismatch;
4. rebuild with that discovered hash and record it as `depsHash`.

Cargo must fit that flow. `fetchCargoVendor` does: the vendored Cargo dependency tree is one fixed-output derivation, and a wrong `cargoHash` produces the single discoverable `got: sha256-…` value the Store already knows how to pin.

`cargoLock` / `importCargoLock` optimises for a different workflow. It avoids aggregate-hash churn when the lockfile changes, but it does so by decomposing the lock into per-crate fetches instead of one vendored fixed-output tree. That removes the single hash discovery point dustcastle's provisioner relies on. It also makes git dependencies a manual hash problem: git sources need explicit `outputHashes`, while `fetchCargoVendor` vendors crates.io and git dependencies under the same aggregate hash.

The trade-off is intentional: dustcastle chooses one discoverable aggregate hash and transparent git dependency vendoring over the no-aggregate-hash-churn ergonomics of `cargoLock`.

## Relocatable staging: why we diverge from `cargoSetupHook`

`fetchCargoVendor` ships a `.cargo/config.toml` that points Cargo's sources at an `@vendor@` placeholder. nixpkgs' `cargoSetupHook` substitutes that placeholder with an absolute Nix store path. That is fine inside one derivation, but it is not the shape dustcastle needs: Project Deps are copied from the Store into a Sandbox-managed environment directory, so the config must remain relocatable after env-only staging.

The Rust spike found the surprising Cargo rule that makes this delicate: a config-relative `directory = "…"` source is resolved against the **grandparent** of the config file, not the config file's own directory. If dustcastle stages Project Deps as:

```text
$CARGO_HOME/config.toml
$CARGO_HOME/vendor/...
```

then a naive `directory = "vendor"` resolves to `parent($CARGO_HOME)/vendor`, missing the staged vendor tree. The Importer therefore rebases `@vendor@` to a basename-anchored relative path, currently:

```toml
directory = "dustcastle-cargo-home/vendor"
```

With `config.toml` living at `$CARGO_HOME/config.toml`, Cargo's grandparent rule resolves `parent($CARGO_HOME)/dustcastle-cargo-home/vendor` back to `$CARGO_HOME/vendor`. The `dustcastle-cargo-home` basename is a shared constant between the Rust Importer and the Sandbox stager; no new staging interface or absolute store path is introduced.

## Considered Options

- **`cargoHash` + `fetchCargoVendor` (chosen).** One fixed-output vendored tree, one discoverable `got: sha256-…` hash, and both crates.io and git dependencies vendored under that same hash. Requires accepting aggregate-hash churn when dependency content changes.
- **`cargoLock` + `importCargoLock`.** Attractive for hand-written Nix because the checked-in `Cargo.lock` drives per-crate fetches and avoids one aggregate vendor hash. Rejected for dustcastle because there is no single FOD hash for the Store's two-pass discovery loop, and git dependencies require manual `outputHashes`.
- **Use `cargoSetupHook`'s absolute vendor substitution.** Rejected for dustcastle staging: it bakes an absolute store path into Cargo config instead of a relocatable path that can ride the existing env-only `cp -RL <project-deps-output> → $CARGO_HOME` mechanism.
- **Hand-write a minimal Cargo config.** Rejected because `fetchCargoVendor` already emits the complete source mapping, including git sources. Rewriting it would duplicate nixpkgs logic and risk missing non-crates.io sources; rebasing its `@vendor@` placeholder preserves that mapping.

## Consequences

- Cargo reuses the same fake-hash → mismatch → real-hash provisioning loop as npm, pnpm, yarn, Python, and Go; no Cargo-specific hash discovery machinery is needed.
- Changing Cargo Project Deps churns the aggregate `cargoHash`/`depsHash`. That is the accepted cost of preserving one uniform Store contract.
- Git dependencies are covered by the same vendored tree instead of becoming a per-dependency `outputHashes` maintenance burden.
- The Project Deps output is relocatable for Sandbox staging: the Store path can be copied into the agreed `CARGO_HOME` basename and used offline with `CARGO_NET_OFFLINE=true`.
- The design depends on the shared Cargo home basename staying in sync between the Importer and Sandbox planner; changing it is a coordinated code change, not user configuration.
- No new CONTEXT.md vocabulary is introduced: `rust` is an Ecosystem instance and `cargo` is a Package Manager instance.
