# Dustless run: drop the Store and the Boundary, run on the trusted host

## Status

accepted — refines [ADR 0017](0017-model-picker-cancel-and-no-model-outcomes.md)'s
no-model outcome. Adds an opt-in run mode alongside the Store-backed default of
[ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md) /
[ADR 0002](0002-consume-sandcastle-via-provider-factories.md) /
[ADR 0003](0003-container-boundary-for-v1.md).

## Context

dustcastle's identity is the shared Nix Store mounted into an isolated Sandbox. But
on a host the operator already trusts and has fully tooled — their own machine, or a
CI runner where the language toolchains and a warm dependency state already exist —
that machinery is pure overhead: provisioning a Store, building an image, and standing
up a container only to reproduce what is already on disk. sandcastle ships a
`noSandbox` provider that runs the agent directly on the host, with no container.

## Decision

Add `dustcastle run --dustless` (`-d`): the same beads orchestration loop (plan →
implement → review → merge), driven over sandcastle's `noSandbox` provider, with the
**Store, the Boundary, and detection all skipped**. The agent runs as the host user in
the host's environment.

- **A sibling seam, not a branch.** A new `withHostSandbox` mirrors
  `withProvisionedSandbox`'s body contract (`{ provider, withSetupHooks }`) but builds
  a bare `noSandbox()` and does **none** of the provision / GC-root / deps-cache /
  image-build / auto-GC work. The two brackets are chosen at the run entry by the
  flag. `prepared` is dropped from the shared `ProvisionedSandbox` interface (no body
  ever read it), so a dustless run owes no `PreparedRun`.

- **Copy host deps, don't install them.** Detection is skipped, so there is no install
  command. Instead each per-issue worktree carries the host's already-installed,
  git-ignored state — `git ls-files --others -i --exclude-standard --directory`
  (`node_modules/`, `.venv/`, `vendor/`, …) — into the worktree via sandcastle's
  `copyToWorktree`. sandcastle copies with `cp --reflink=auto`, so on a CoW filesystem
  this is a metadata-only clone (near-zero time and disk). This is the inverse of the
  Store-backed default ([ADR 0012](0012-impure-cached-deps-unified-gc.md)/
  [ADR 0016](0016-deps-cache-project-fingerprint-loose-cache.md)): the host *is* the
  cache.

- **The host seam injects nothing.** No Store mount, no `~/.pi` login mount, no curated
  `GIT_CONFIG_*` credential wiring. The agent uses the host's real `PATH`, `git`/`gh`
  config, credential helpers, and `pi` login. Injecting dustcastle's curated
  credentials would *override* the host's own auth — backwards for a host-fidelity mode.

- **No-model never provisions, in any mode.** Because dustless has nothing to realize,
  the first-run "no model → provision the Store and show posture" path is removed
  outright rather than special-cased. `dustcastle run` with no configured model now
  prints the `dustcastle config` hint and exits, provisioning nothing, whether or not
  `--dustless` is set. This overturns the one consequence of
  [ADR 0017](0017-model-picker-cancel-and-no-model-outcomes.md) that still provisioned
  on the interactive pi-has-no-models path; `prepareRun` no longer runs from `main.ts`.

- **Loud, but no prompt.** Never-silent ([ADR 0014](0014-structured-logging-owned-port-afk-flight-recorder.md))
  demands the inverted safety posture be stated every run: a `warn`-level line —
  *agents act directly on the host with no isolation* — alongside the agent/mode lines
  (`logHostPosture`). There is no confirmation prompt: the `-d` flag is the opt-in, the
  primary use is non-interactive (CI), and `noSandbox` still honors the agent's own
  permission model (it does not pass `--dangerously-skip-permissions`).

## Considered alternatives

- **An install hook instead of a copy.** Rejected: it resurrects exactly the detection
  machinery dustless exists to skip, and on a warm host a reflink copy of the
  already-built deps is faster than any re-resolve.
- **Run in-place on `HEAD` (no worktrees).** Rejected: it forfeits the loop's
  parallelism and mutates the operator's working tree. `noSandbox` supports the named
  per-issue branch strategy, so the worktree loop survives unchanged.
- **An `if (dustless)` branch inside `withProvisionedSandbox`.** Rejected: that bracket
  is saturated with Store invariants (GC-root pin/release symmetry, deps-cache pinning,
  auto-GC in `finally`); a dustless early return smears "dustless knows nothing about
  the Store" across the one place those invariants live.

## Consequences

- Dustless trades isolation, provisioning, and byte-reproducibility for host fidelity
  and speed. It is **opt-in and host-trusting by contract**; the loud posture is the
  only guard. Native/compiled deps are a strength here, not a risk — same host, same
  arch, no container mismatch.
- On a non-CoW filesystem (ext4 without reflink) the worktree copy degrades to a full
  `cp -R` under sandcastle's 60s `copyToWorktree` timeout, so a multi-GB ignored tree
  can time out. CoW hosts (btrfs/XFS/APFS/ZFS) are unaffected.
- Copying the *whole* ignored set pulls local cruft and secrets (`.env`, local DBs)
  into each worktree — but in `noSandbox` the agent already has full host filesystem
  access, so this exposes nothing it could not already read at the repo root.
- Plan and merge phases run directly on the host's main checkout (not a worktree),
  which is correct: `bd close` persists to the real `.beads` and merges land on the
  real target branch.
