# The Deps Cache is one deep module owning its layout, with a run-facing and a GC-facing face

## Status

accepted — **refines [ADR 0012](0012-impure-cached-deps-unified-gc.md)** (which introduced the impure cached deps + the deps-cache pool, but landed its pieces scattered across `src/store/` and `src/sandbox/plan.ts`). Keeps [ADR 0007](0007-store-lifecycle-management.md)/[ADR 0012](0012-impure-cached-deps-unified-gc.md)'s pool-agnostic GC brain (`pool.ts` `collectPool`/`collectPools`) **unchanged** — this ADR is about where the deps-cache *implementation* lives, not the brain's seam.

## Context

ADR 0012 added the **Deps Cache** — the host-owned, lockfile-hash-keyed pool of assembled Project Deps (`node_modules`/`site`/`vendor` produced by an in-Sandbox install), kept warm by the same recency/ceiling brain as the Store. CONTEXT.md names it a **peer of the Store, not part of it** (the Warm/cold and Project Deps entries).

But its implementation landed as six shallow pieces across five files:

- `store/depsCacheKey.ts` — lockfile → hash;
- `store/depsCache.ts` — `depsCacheDecision` (host hit/miss) + `populateCacheCommand` (a shell builder);
- `store/depsCachePool.ts` — the `Pool` mechanism (`measure`/`entries`/`pin`/`evict`) + `depsCacheEntryDir`;
- `sandbox/plan.ts` — `restoreFromCache` (a second shell builder), the `DepsCacheDecision`/`DepsCachePopulate` types, the hit/miss branch;
- `run/index.ts` — the pin loop + `populateDepsCache` (the `spawnSync`).

The smell is **duplicated layout knowledge**: the on-disk path `<cacheDir>/<hash>/<stageDir>` is re-derived in three places (`depsCacheEntryDir`, `restoreFromCache` at `plan.ts:224`, `populateCacheCommand` at `depsCache.ts:45`), which must silently agree or restore and populate copy to different paths. Reasoning about a cache entry's life means bouncing all five files.

## Decision

**Collapse the Deps Cache into one deep module at `src/store/depscache/`, with exactly one internal owner of the on-disk layout.** The module presents two faces to two consumers; the generic `Pool` interface in `pool.ts` is untouched.

- **One module, two faces.** The Deps Cache faces two seams: the **run-facing** side (`decide` / `restoreCommand` / `populateCommand`, consumed by `plan.ts` and `run/index.ts`) and the **GC-facing** side (a `Pool`, consumed by the `collectPool` brain). Both move into `src/store/depscache/`. It stays under `store/` — not a top-level peer — because the GC brain that drives it lives in `store/`; the subdir (plus the CONTEXT.md term) does the concept de-conflation the flat files didn't.

- **One layout owner.** Internal `entryDir(cacheDir, hash)` (`<cacheDir>/<hash>` — the Pool's granularity) and `contentPath(cacheDir, hash, stageDir)` (`<cacheDir>/<hash>/<stageDir>` — the run-facing granularity) are the *sole* owners. The Pool stays blind to `stageDir` by design (it measures/evicts whole opaque entries); only the run-facing builders know the nesting. The three re-derivations collapse into these two helpers.

- **Builders, not executors; free functions, not methods.** `restoreCommand`/`populateCommand` are pure functions returning shell strings — `restore` is *forced* to be a string (sandcastle runs it as a host `onWorktreeReady` hook), and matching `populate` keeps one shape tested by string assertion. They are **free functions, not instance methods**, so `plan.ts` need not fabricate a stateful pool handle just to template a path. The only stateful thing — pins + fs `measure`/`evict` — is the `depsCachePool` factory (relocated, signature unchanged, still satisfies `Pool`). `gitExclude` stays in `plan.ts` (a worktree-git concern, not a cache concern).

- **`cacheDir` is run-level config, not a per-ecosystem result.** Drop `cacheDir` from `DepsCacheDecision` (now `{ lockfileHash, hit }`) and from `DepsCachePopulate` (drop the pre-joined `cacheEntryDir`); thread `cacheDir` once at the `SandboxPlanSpec` level. A polyglot repo's N decisions share one `cacheDir`, so restating it per decision modelled config as a result. The `Decision`/`Populate` types move out of `plan.ts` into the module.

## Considered Options

- **Keep the Pool fully separate; consolidate only the run-facing scatter.** Smaller change, but `depsCacheEntryDir` stays a shared seam between two modules and the layout owner is still split. Rejected: the layout is the thing worth concentrating.
- **Instance methods (`cache.restoreCommand(...)`).** Uniform API and structural layout enforcement, but forces `plan.ts` to construct a GC-pool handle to format a string — the false coupling the deepening removes — and doesn't even unify pin-state (each site constructs its own instance). Rejected.
- **Keep `cacheDir` on the `Decision`.** Less churn, self-contained, but restates an input as a result and repeats across a polyglot's decisions. Rejected for the config/result split.
- **Top-level `src/depscache/`.** Purest concept boundary (peer of the Store), but the brain coupling makes `store/` defensible; held.

## Consequences

- **Locality:** the layout lives in one place; `restore` and `populate` cannot drift to different paths because one module writes both.
- **The interface is the test surface:** builders are pure input→string (no process spawning, no instance setup); the Pool face is exercised through the brain as today.
- **Leverage:** `plan.ts` and `run/index.ts` stop knowing the layout; the `Decision`/`Populate` DTOs leave `plan.ts`.
- **`pool.ts` is untouched** — the brain's pool-agnostic seam is preserved; only the deps-cache *adapter* relocates.
- **Cross-process pins are unchanged and still a known limitation** (the deps-cache pin is an in-memory `Set` per pool instance; see dustcastle-xyx). This ADR does not address it — it only relocates the mechanism.
- **CONTEXT.md:** **Deps Cache** is promoted from a descriptive phrase to a first-class term (a host-owned, lockfile-hash-keyed pool of assembled Project Deps; a peer of the Store under the unified GC brain) — pending the maintainer's call on adding the glossary entry.
