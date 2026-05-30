# Store lifecycle: dustcastle manages GC, optimise, and scoped roots

The shared [Store](../../CONTEXT.md) grows with every unique package-version it ever builds, and Nix **never garbage-collects by default** — an unmanaged `/nix/store` is the famous 50GB complaint. Because the Store is dustcastle's core asset ([ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)), dustcastle **owns its lifecycle** rather than leaving it to the user: it keeps the Store lean with three mechanisms, so "one shared place" stays *light*, not a disk leak.

## The three mechanisms

1. **Scoped GC roots — one per active project.** A Nix path is collectable only when nothing references it (a "GC root"). dustcastle registers a root for each project's *current* toolchain + deps closure (keyed by lockfile hash). When a project's lockfile changes or the project goes idle, its **old** closure loses its root and becomes collectable — without touching closures other projects still reference. This is what makes per-package dedup safe to garbage-collect: a shared path stays pinned as long as *any* active project roots it.

2. **`nix-collect-garbage` on a policy.** dustcastle runs GC on a threshold (a disk ceiling), deleting only unrooted paths. The user never runs it by hand — the chosen trigger, ceiling, and recency tail are resolved in *The chosen auto-GC policy* below.

3. **`nix store optimise` — file-level dedup on top of path-level.** Hard-links identical files *across* store paths, reclaiming space (commonly 25–35%) beyond the dedup content-addressing already gives.

## The trade-off (why this is an ADR, not just config)

GC aggressiveness trades **disk** against **rebuild cost**:

- **Too eager** — collect a version the moment no *active* project roots it, and the next sandbox that wants it pays a cold rebuild/fetch (the cache-miss cost from [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)).
- **Too lazy** — keep everything, and version sprawl reintroduces the bloat we're avoiding.

The chosen stance: **keep what active projects root + a bounded recently-used tail; collect the rest on a disk ceiling.** Recency keeps the common toolchains warm (a just-bumped Node minor is likely to come back) while bounding total size; the tail is a **byte-budget LRU** set and the ceiling is a **high/low watermark** (see *The chosen auto-GC policy* below). An optional **remote binary cache** (Cachix / attic / harmonia) softens eager GC further — a collected path is re-fetched, not rebuilt from source.

## The chosen auto-GC policy (v1)

Auto-GC is **the main path**: the user never tends the Store — GC is a property of *using* dustcastle, not a chore. The manual `dustcastle gc` is demoted to a debug/force affordance. The policy resolves the three open levers — *when* to fire, *how big* is too big, and *what stays warm*.

**Trigger — post-`run()`, asynchronous.** The Store only grows during provisioning, so the moment a `dustcastle run` returns is the only time new bloat can appear. As `run()` returns its result, dustcastle spawns a **detached one-shot child** that sweeps in the background, then exits. This keeps GC entirely off the hot path (zero perceived latency) and — being a one-shot, not a resident process or timer — does **not** reintroduce the root daemon [ADR 0008](0008-rootless-store-install.md) forbids.

**Ceiling — a hybrid high/low watermark, derived from the disk.** A sweep fires when *either* the Store exceeds a disk-derived size cap *or* free space on the Store's filesystem drops below a floor — whichever bites first. No absolute number is baked in (it would be wrong on both a 256 GB laptop and a 4 TB workstation); both thresholds derive from the actual filesystem, so the default is zero-config and machine-adaptive. Following the universal watermark pattern (kubelet image GC 85→80 %, Nix's own `min-free`→`max-free`, Linux page reclaim), the ceiling is the **high** watermark that *triggers* and the recency-tail size is the **low** watermark we *land at* — collecting past the trigger to a strictly lower floor so GC cannot thrash at the boundary.

**Warm set — a byte-budget LRU recency tail.** What survives a sweep is the active projects' roots plus the most-recently-used closures that fit a **byte budget** (that budget is the low watermark above). Byte-budget LRU is the build-cache consensus (ccache, Bazel, browser/CDN caches) precisely because closures vary wildly in size — a count-based "keep N" is size-blind and would let a few large closures blow the disk while claiming to keep "N". *Frequency-aware* eviction (S3-FIFO / a use-count second chance) is the documented upgrade path, deferred until real usage shows hot closures being churned: a miss here only costs a rebuild, eviction only happens under pressure, and the policy lives behind one pure function (`recencyTailKeys`) swappable without touching the trigger, persistence, or roots.

**optimise-first.** When over the ceiling, dustcastle runs the **non-destructive** `nix store optimise` (file-level hard-link dedup) *first*, re-checks the ceiling, and only falls through to the destructive `nix-store --gc` if still over. Trying the lever that *cannot* cause a cold rebuild before the one that can directly serves the trade-off above. `optimise` is kept off the hot path (it is the most size-sensitive op) but is acceptable in the background because it is rare (only over-ceiling) and incremental after its first pass.

**Persistence.** The recency decision reads a derived-state index at `~/.dustcastle/recency.json` (`{projectKey: {lastUsedAt, closureBytes}}`) — *state*, never config, so it stays out of `config.json` ([ADR 0009](0009-no-project-local-config.md)). `run()` upserts the current project's record and registers a **persistent recency root** (distinct from the in-flight **scoped root** of mechanism 1, which is still released on completion); the sweep prunes the recency roots outside the byte budget, then collects. Writes are atomic (temp + rename), last-writer-wins (a lost timestamp bump is harmless and self-heals next run), and a missing/corrupt file degrades to an empty tail — it must never crash a run.

**Never-silent, reconciled with never-worry.** "The user never worries" and the never-silent stance meet as: the sweep is quiet by default, appends a one-line summary (`freed X`) to `~/.dustcastle/gc.log`, and the **next** `dustcastle run` surfaces that one line at startup. No prompt, no decision, no config — honesty without noise. The zero-config default works with no config file at all.

**Safety.** Because the sweep is a separate process spawned *after* `run()` has its result, a failed, hung, or killed GC cannot break a run — best-effort by construction. A `~/.dustcastle/gc.lock` serializes sweeps and is skipped when a run is active. In-flight closures stay protected by live scoped roots and warm closures by recency roots — `nix-store --gc` respects both. As a mid-provision backstop, a conservative `min-free`/`max-free` in the rootless nix-portable config lets Nix self-protect against a genuine disk-full *during* a build, respecting the same roots.

## Considered Options

- **Never GC (Nix default).** Simplest; the 50GB-store complaint. Rejected — bloat is the exact thing this manages.
- **Leave GC to the user.** Punts dustcastle's core asset back to the user's expertise — contradicts "absorb the pain." Rejected.
- **Collect everything unrooted immediately, no recency tail.** Minimal disk, maximal cold rebuilds — defeats the warm-shared-store value. Rejected as default; available as an aggressive mode.
- **Synchronous post-`run()` GC (blocking the run's return).** Rejected — adds GC latency to the hot path; the detached one-shot removes it entirely while keeping the same trigger point.
- **A background daemon or OS timer (launchd / systemd-timer).** The only thing "more automatic" than post-run. Rejected — a resident process / per-OS timer contradicts the rootless, no-daemon, OS-agnostic stance ([ADR 0008](0008-rootless-store-install.md)).
- **Count-based recency tail (keep N closures).** Rejected as default — size-blind: N closures may be 500 MB or 50 GB, so it cannot serve as the low watermark. Byte-budget LRU bounds the resource (disk) we actually care about.

## Consequences

- The Store stays bounded and lean without user intervention — the "one place" is light by construction, reinforcing [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)'s aggregate-lighter-than-N-images claim.
- GC is invisible: the detached post-run one-shot keeps it off the hot path, and its only user-facing trace is a one-line "freed X" surfaced at the *next* run — never-silent without ever asking the user to think about the Store.
- A collected-then-needed path costs a cold fetch/rebuild; the recency tail and an optional remote cache keep this rare.
- GC roots are keyed by lockfile hash, so this is coupled to ecosystem detection ([ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md)) — the same hash that selects the importer pins the root.
