# Consume sandcastle via its provider factories

dustcastle uses sandcastle as a library, standing up sandboxes through its `createBindMountSandboxProvider` / `createIsolatedSandboxProvider` factories rather than forking sandcastle or hard-wiring its own isolation. dustcastle's identity is the global Toolchain/Store manager and UX; the provider is a mechanism it *uses*, not what it *is*.

## Interface: dustcastle is a CLI, not a library — and the surface is `dustcastle run`

The same "uses, not is" principle one level up: **dustcastle's public surface is a CLI, not a library or SDK — because sandcastle is already the library.** Shipping a dustcastle SDK would just duplicate the layer beneath us. If you want to drive sandboxes *programmatically* from TypeScript, you import sandcastle directly; dustcastle is the global tool you `install once` that does the UX sandcastle doesn't (manage the shared Store, detect the Ecosystem, provision Toolchain + deps, GC).

- **The surface is one zero-argument command: `dustcastle run`.** It takes **no command argument at all.** dustcastle is **not a test runner** — `run` kicks off **sandcastle's flow** (its agent-in-Sandbox orchestration), with dustcastle's contribution being that the Sandbox is **provisioned from the shared Store instead of a per-project Docker image**: detect the Ecosystem ([ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md)), realize Toolchain + deps into the Store, stand up the Sandbox via the provider factories, then hand off to sandcastle. The agent inside does the work (editing, *and running the project's tests* — which is why the Ecosystem model carries a run-tests slot: so the provisioned environment is *capable* of it, not because dustcastle invokes it). The task/agent/branch config is sandcastle's domain, not a dustcastle argument — which is why `run` needs none. No passed command means no flag passthrough, no `--`, no per-ecosystem example bias; the whole class of CLI-argument problems disappears.
- **Everything else is automatic and invisible**, per dustcastle's "absorb the complexity" thesis: ecosystem detection, provisioning, session reuse (a warm per-project Sandbox so state persists across runs without the agent managing lifecycle), and Store GC/optimise ([ADR 0007](0007-store-lifecycle-management.md)) are *not* agent-facing commands. The agent never `start`s, `stop`s, or `gc`s. At most, operator/debug subcommands exist but stay out of the way.
- **Language-agnostic by surface.** dustcastle is *implemented* in TypeScript (it has to call sandcastle's TS factories), but that is an implementation detail — a Python or Rust agent harness drives it by shelling out to the CLI, which keeps the any-Ecosystem promise honest at the interface, not just inside the Store. A TS harness wanting library control bypasses dustcastle and uses sandcastle.
- **The boundary this pins:** no "dustcastle SDK," and no command-argument surface to grow into a sprawling management API. The CLI is the contract; sandcastle is the library.

## Considered Options

- **Fork sandcastle.** Rejected — we'd inherit maintenance of agent-lifecycle and branch-strategy code that sandcastle already does well; our value is the Store, not the orchestrator.
- **Hard-wire a single boundary.** Rejected — the factory split (bind-mount vs isolated) makes the Boundary a *swappable* decision instead of a foundational one, so a container fallback can be added later without rearchitecting.
- **Build our own sandbox abstraction from scratch.** Rejected — the provider contract (`exec`, `close`, `copyFile*`, `worktreePath`) is small, sufficient, and already proven (sandcastle's Vercel provider shows a Firecracker backend fits it).

## Consequences

- Image/environment provisioning lives *outside* the provider contract (sandcastle assumes the environment is ready at `create()`), which is precisely the seam dustcastle occupies with the Nix Store.
- We stay coupled to sandcastle's provider API; if it changes, our provider construction changes. Acceptable — it's a thin, well-defined surface.
