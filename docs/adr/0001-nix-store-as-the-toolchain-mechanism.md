# Nix store as the toolchain mechanism

dustcastle backs every sandbox's Toolchain with a single, globally-shared, content-addressed **Nix store** (`/nix/store`) rather than per-project image builds. This is the core bet: the immutable, deduplicated store is the "one place" that fulfils dustcastle's reason to exist, and it can be shared read-only into many sandboxes at once.

## Considered Options

- **Per-project Dockerfiles (sandcastle's default).** Rejected — this *is* the tedium dustcastle exists to kill: N projects, N image builds, N sets of problems, no cross-project sharing.
- **devcontainer features / OCI image layers.** Rejected — dedup is coarse (whole-layer, not per-package), reproducibility is opt-in and rarely achieved (`apt install`, unpinned bases), and every project still re-bakes an image.
- **Runtime version managers (mise / asdf).** Rejected as the core — no content-addressed shared store, and they manage *runtimes only*, not system libraries (ffmpeg, libvips, postgres) which real test suites need.
- **Nix-store wrappers (devbox / devenv / flox).** Same store, friendlier surface. Rejected for v1 because flox's "shared catalog" is partly a hosted commercial service, and absorbing Nix's authoring complexity is dustcastle's whole job — so we own the engine directly rather than reskinning someone else's.

## Why not the easier paths (and why the famous Nix exits don't move us)

Nix is the *hard* path, and that's a fair objection. The reason the easier alternatives lose is **breadth** — "works for all ecosystems + system libs + reproducible + zero-config." Each easy path is easy only *per ecosystem* and doesn't compose:

- **Docker image per project + native caches.** A `FROM node:20` base layer dedups the toolchain, BuildKit cache mounts dedup downloads, and each ecosystem's own global cache (pnpm store, cargo registry, go module cache, uv cache) dedups deps per-package. This genuinely covers ~80% of the pitch with tooling everyone knows — **for one ecosystem.** Across *all* of them it becomes N base images + N cache volumes + N hand-written Dockerfiles, and — the residual it **cannot** solve — **system libraries (ffmpeg, libvips, postgres) are `apt install`ed per image, deduped across none.** The "simple" path's simplicity does not compose with breadth; it re-creates the very per-project tedium dustcastle exists to kill.
- **Railway dropped Nix (nixpacks → Railpack/mise).** A different use case: building per-deploy **OCI images**. Their stated pains were the fat `/nix/store` *layer* caching badly and whole-commit versioning — but we **mount** the store read-only, never bake it into an image, so the "bad image layer" property is irrelevant (even an asset). And Railpack's replacement, **mise, is a version switcher with no shared dedup store and no system libraries** — it can't do our core job at all, so the exit doesn't generalize.
- **flox / devbox / devenv.** The Nix engine with nicer UX — but they sit at *dustcastle's own altitude* (they're UX layers over Nix too), they make you **declare** a toolchain rather than detect it, none build project deps into a shared store or wire it into isolated sandboxes, and flox's catalog is partly a **hosted commercial service**. Building on them = reskinning a reskin + a service dependency. We reuse their *ideas and data* (e.g. nixhub/lazamar version→pin index) freely; we don't build the product *on* them.

The residual that only Nix delivers — **per-package dedup + system libraries + reproducibility, unified in one mechanism across every ecosystem** — is exactly what "all kinds of tests, agent configures nothing" requires. The two honest costs we accept: **version→nixpkgs-pin resolution** (mitigated by reusing existing commit↔version data, [ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md)) and **cache-miss-builds-from-source** (one-time, paid centrally into the shared store).

## Consequences

- Only the Nix store gives per-package dedup + reproducibility + full system-library coverage across *all* ecosystems simultaneously. That combination is why it wins.
- The cost is Nix's steep authoring complexity. We accept this deliberately: hiding it behind maximal UX is dustcastle's purpose, not a side concern.
- **The store is dustcastle-managed, which is what keeps it from ballooning.** It grows with *unique package-versions*, not *projects × deps* — overlapping deps and system libs are stored once and shared read-only (zero-copy) into all sandboxes, so it's *lighter* in aggregate than N Docker images, not heavier. The real bloat sources — version sprawl and Nix's no-GC-by-default — are dustcastle's responsibility: `nix store optimise` (file-level hard-linking), scoped GC roots per active project, and a `nix-collect-garbage` policy so unreferenced versions don't accumulate ([ADR 0007](0007-store-lifecycle-management.md)). An *unmanaged* `/nix/store` is the famous 50GB complaint; a *managed* one is the lean option for breadth.
- Project Deps are **Nix-built into the shared store** by default (pure, deduped — [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)), not installed ad-hoc per sandbox; impurity is policy-gated and never silent.
