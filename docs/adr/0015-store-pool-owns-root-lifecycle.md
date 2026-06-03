# The Store pool owns its full root + recency lifecycle; `gc.ts` splits into a nix port, a GC-root lifecycle, and the warm-set brain

## Status

accepted — **refines [ADR 0012](0012-impure-cached-deps-unified-gc.md)** (the unified `Pool` GC brain) and **[ADR 0007](0007-store-lifecycle-management.md)** (Store lifecycle: scoped/recency roots, the recency index, the byte-budget warm set). Where [ADR 0013](0013-deps-cache-deep-module.md) deepened the *deps-cache* adapter and deliberately left the `Pool` seam **untouched**, this ADR deepens the *Store* adapter and **amends the `Pool` seam itself** — it grows a `warm` method so the Store pool owns its whole recency lifecycle. Keeps [ADR 0008](0008-rootless-store-install.md) (no daemon — roots stay on-disk symlinks).

## Context

`src/store/gc.ts` (330 L) is a junk drawer, not a module: it mixes five unrelated jobs behind no single interface — the nix-portable command vocabulary + report parsers + runner, the scoped/recency GC-root lifecycle, the byte-budget warm-set policy (`recencyTailKeys`), the `RecencyRecord` type, and the default-dir helpers. The deletion test confirms the smell: deleting `gc.ts` *redistributes* complexity across its callers rather than concentrating it.

The structural tell is two live asymmetries the unified `Pool` brain (ADR 0012) was meant to remove but didn't, for the Store:

- **The Store pin runs out-of-band.** `withProvisionedSandbox` pins the *deps cache* through the `Pool` seam (`cachePool.pin(hash)`) but pins the *Store* by calling `registerScopedRoots` directly — bypassing `storePool.pin`, whose only caller is its own test. The `Pool.pin`/`release` seam exists for the Store and is **dead in production**.
- **Warming is half-behind the seam.** `storePool.evict` prunes cold recency roots (the *prune* side of warming), but the recency root is *written* out-of-band by `updateRecency` → `registerRecencyRoot`, and the recency index is written by `upsertRecency` — neither behind the seam. The pool *reads* the recency index (`entries()`) but does not own *writing* it.

A separate review candidate ("the lease stack") proposed routing the Store pin through one `Pool` seam; this ADR absorbs it, because splitting `gc.ts` cannot leave those seams half-wired without re-creating the junk drawer as tidy files that still pin the Store two ways.

## Decision

**Dissolve `gc.ts` into deep modules, and make the Store pool the sole owner of its root + recency lifecycle — pinning, warming, and pruning all behind the `Pool` seam.**

- **`nix.ts` — the nix port (full).** The nix-portable runner (`NixRunner`/`NixResult`/`nixPortableRunner`), the whole `nix-store` command vocabulary (`addRootArgs`/`collectGarbageArgs`/`optimiseArgs`/`gcQueryArgs`), and the report parsers (`parseGcReport`/`parseOptimiseReport` + their types) live here as one module. The individual arg-builders are deletion-test-*shallow* (one literal each), but they are kept together deliberately: the value is a single learnable nix surface, not per-function depth. `ceiling.ts` stops re-exporting the runner types; consumers import from `nix.ts`.

- **`gcRoots.ts` — the GC-root lifecycle, private to `storePool`.** `registerScopedRoots` (→ a handle with `release()`), `registerRecencyRoot`, `pruneRecencyRoots`, over a shared private `addClosureRoots`. Scoped and recency roots share the add-a-root *mechanism* but keep their *distinct* lifecycles (release-as-unit vs prune-by-keep-set) — **not** unified behind a `roots(kind)` factory, which would unify at the wrong axis and leak a discriminated-union handle. The default root-dir helpers move into `storePool`, so no caller imports `gcRoots` directly.

- **`pool.ts` — the recency/ceiling brain — grows `warm`, and owns the warm-set policy in its own vocabulary.** `recencyTailKeys` moves beside its only consumer (`collectPool`) and speaks `PoolEntry`, not `RecencyRecord`, deleting the `PoolEntry → RecencyRecord` round-trip the brain did just to call it. The `Pool` interface gains an optional `warm?(key)` — the *write* side of warming — so a pool that keeps entries warm owns read (`entries`), write (`warm`), and prune (`evict`) symmetrically. `RecencyRecord` moves to `recency.ts` (its persistence leaf), **not** `pool.ts` — keeping a leaf from depending on the brain.

- **`storePool` collapses both asymmetries.** `storePool.pin`/`release` go live; `storePool.warm` writes the recency root **and** upserts the recency index (computing `closureBytes`). `withProvisionedSandbox` pins/warms/releases the Store *through the pool* — symmetric with the deps cache — and the out-of-band `registerScopedRoots`/`registerRecencyRoot`/`upsertRecency` calls in `withProvisionedSandbox`/`updateRecency` move behind the seam. `entries()` does the one honest `RecencyRecord → PoolEntry` map an adapter is for.

- **Test surface is the `Pool` seam.** `gcRoots` has no direct test file; its mechanism is exercised through `storePool`'s `pin`/`release`/`warm`/`evict`. The key-sanitization path-traversal property — a `/` in a project key must not escape the roots dir — is **re-asserted** in `storePool.test.ts`, not dropped.

## Considered Options

- **`nix.ts` as just the runner; move parsers/args to their sole consumers.** Purer by the deletion test (each shallow builder beside its one caller), but fragments the `nix-store` command family across `gcRoots` and `storePool`. Rejected: a single learnable nix surface is worth more than per-function depth here.
- **Pure split — relocate only, keep the out-of-band Store pin.** Smallest, every test moves verbatim. Rejected: it leaves the dead `Pool.pin` seam and the warming asymmetry in place — the junk drawer reappears as tidy files that still pin the Store two ways.
- **Collapse the scoped pin but leave warming out-of-band.** Rejected: it leaves `gcRoots` with a public face (`registerRecencyRoot`) and the pool owning prune-but-not-write — an asymmetric half-seam.
- **`recencyTailKeys` in its own `warmset.ts`** (one pure function, one consumer → shallow by the deletion test) or **`RecencyRecord` into `pool.ts`** (forces the recency *persistence* leaf to import from the *brain* — a backwards seam, and keeps the round-trip). Both rejected.
- **A `roots(kind)` factory for `gcRoots`.** Rejected — unifies at the directory/registration axis while the genuinely-different lifecycles (release-as-unit vs prune-by-keep-set) leak out as optional handle methods.

## Consequences

- **The `Pool` seam is now amended, not frozen.** Unlike ADR 0013, this ADR changes the contract: `warm?(key)` is part of it. The deps-cache pool may implement `warm` later — a cache *hit* that doesn't refresh its entry's recency can age a still-used entry out (a latent staleness smell, tracked separately, not fixed here).
- **`storePool.pin`/`release` become live and stay cross-process-safe** — the Store's pins are on-disk roots that `nix-store --gc` honours regardless of which process wrote them, so routing through the seam keeps the protection it always had. This does **not** touch the deps-cache *in-memory* pin limitation (dustcastle-xyx).
- **Less code, not more:** the dead `pool.ts` round-trip and two zero-consumer re-exports (`storePool`'s `closureSizeBytes`, `pool.ts`'s `GcReport`/`OptimiseReport`) delete; `gc.ts` deletes.
- **`gcRoots` is private and deep at once** — privacy (one importer) and depth (rich root behaviour behind three verbs) are orthogonal; tested through the seam.
- **CONTEXT.md:** adds **GC root** (the dustcastle-owned scoped-vs-recency root distinction the split is named for).
