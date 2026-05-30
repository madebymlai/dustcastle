# dustcastle

<p align="center">
  <img src="docs/dustcastle.png" width="480" alt="dustcastle — a castle built from dust">
</p>

```
                                                                        
                               ░▒▒▄▒▒▄▒▒░                               
                               ░▒▒▒▒▒▒▒▒░                               
                               ▀▓▀▓▀▀▓▀▓▀                               
                        ▄▄▄▄▄▄▄▄▒░▒▄▄░▒▒▄▄▄▄▄▄▄▄                        
                        ▒▒▀▒▒▒▒▓▒▒░▀▀░▒▒▒▒▒▒▒▀▒▓                        
        ▄▄▓▒▒▓▒▒█▄▄▄    ▒▓▓▓▓▓█▓▒░▒░▒░▒▓▒▓▓▓▓▓▓▓    ▄▄▄▓▒▒▓▀▓▓▄▄        
       ░▀▓▒▀▒▀▒▒████▒   ▒▒▒▄▒░▓▄▒▒▒▒▒▒▒▒▄▓░▒▄░▒▒   ▒▓▒▀▒▒▒▀▒▀▒██░       
       ░▄▄▄▄▄▄▄▄████▒   ▒▒▒▓▒░▓▓░▒▒░▒░░▒▒▒░▒▓▒▒▒   ▒▒▒▄▄▄▄▄▄▄▄██░       
        ▀▀▀▀▒▒▀▓███▀░▄▄▄▒▒▒░▒▒█▓▒▒▒▒▒▒▒▒▒▓▒▒░░▒▒▄▄▄░▀▀▀▀▓▀▒▒▀██▀        
        ░▒▒▒▓█░▒███▓░▓▓▓▓▒▒░▓░▀▀▒▒▀▒▒▀▒▒▀▀▒▓░▒▒▓▓▓▓░▒░▒▒▒░█▓▒██▒        
        ▒▒▒▒▓▀░▒███▓░▓▓▓▓░▒░▓▄▄▓▄▄▄▄▄▄▄▄▄▄▄▓░▒▒▓▓▓▓░▒░▒▒▒░▀▓▒██▒        
        ▒▒▒▒░░░▓███▓░▓▓▓▓▄▒▒▒▓▀▒▒▒▀▒▒▀▒▒▒▀█▄▒▒▄▓▓▓▓░▒▄▒▒▓▒░░░██▒        
        ▒▒▓▒▒▒░▒██▒▓▓▒▒▓▒▒▓▓▒▓░▒▒▒▒▒▒▒▒▒▀▒▓▒▓▓▒▓▓▒▒▓▓▒▓▒▒░▒▒░██▒        
        ▒▒▓▒▒▒░▒██▒░░▒░░░▒░░▒▓▒▒▒▓▄██▄▓▒▒▒▓▒░░▒▒░▒▒░░▒▓▒▒░▒▒▒██▓        
        ▒▒▒▒▒▒░▒██▒▒▒▒▒▒▒▒▒▒▒▓░▒▓██████▓▒░▓▒▒▒▒▒▒▒▒▒░▒▓▒▒░▒▒░▓█▓        
        ▓▄▓▒▄▄▄▓██▒░▒▒▒▒▒▒▒▒▒▓░▒▓█▓█▓▓█▓▒▒▓▒▒▒▒▒▒▒▒▒░▒▓▄▓▄▄▄▄██▓        
       ░▒▒▒▒▒▒▒▒██▓░▒░▒▒▒▒▒░▒▒░▒▓██████▓▒░▓▒░░░▒▒▒░▒░▓▒▓▒▒▒▒▒▒██░       
     ▄▄▒▒▒▒▒▒▒▒▒▀▀▀▀▒▒▒▒▒▒▒▒▒▓▒▓▓▀▀▀▀▓▀▓▓▒▓▒▒▒▒▒▒▒▒▒▀▀▀▓▒▒▒▒▒▒▀▀▒▄▄     
                                                                        
```


A **global toolchain manager for AI coding agent sandboxes**. Install once; every
project's agent sandbox draws its toolchain from one shared, deduplicated Nix store
instead of per-project image builds — across any language ecosystem.

This README is the narrative + context. For the precise decisions see
[`docs/adr/`](docs/adr/); for the vocabulary see [`CONTEXT.md`](CONTEXT.md).

---

## The problem

[sandcastle](https://github.com/mattpocock/sandcastle) (`@ai-hero/sandcastle`)
orchestrates AI coding agents in isolated sandboxes. Its model is **per-project**:
every repo carries its own `.sandcastle/Dockerfile`, and you build/rebuild that
image per project. N projects → N Dockerfiles → N image builds → N sets of problems,
with no sharing between them. It's also biased toward **npm/TS**.

dustcastle's bet: 90% of every such Dockerfile is identical boilerplate (a runtime,
git, gh, Claude Code). Kill the per-project build entirely — provide the toolchain
from **one shared place**, for **any ecosystem**, so the agent configures nothing.

---

## The core mental model: two orthogonal axes

The single most important idea, and the one that's easy to conflate:

| Axis | Question | Answer |
|---|---|---|
| **A — the Store** | How is the toolchain described, stored, shared? | A shared, content-addressed **Nix store** ([ADR 0001](docs/adr/0001-nix-store-as-the-toolchain-mechanism.md)) |
| **B — the Boundary** | What stops the agent damaging the host? | A **container** for v1; microVM as a swappable upgrade ([ADR 0003](docs/adr/0003-container-boundary-for-v1.md)) |

**These are independent.** dustcastle's novel value — "install once, dedup
everywhere, any ecosystem" — lives entirely on **Axis A** and does **not** depend on
the Boundary. You can mount the same shared `/nix/store` into a plain container *or*
a microVM. We initially coupled "I want the shared store" with "I want microVMs";
they're separable, and keeping them separate is what makes the Boundary a swappable
decision ([ADR 0002](docs/adr/0002-consume-sandcastle-via-provider-factories.md)).

---

## How it works

dustcastle is the **global Store manager + UX**. It uses sandcastle as a *library*,
standing up sandboxes through its `createBindMountSandboxProvider` /
`createIsolatedSandboxProvider` factories — that's an implementation detail, not
dustcastle's identity ([ADR 0002](docs/adr/0002-consume-sandcastle-via-provider-factories.md)).
The sandcastle provider contract is small: `create()` → a handle with `exec`,
`close`, `copyFile*`, `worktreePath`. Image/environment provisioning lives *outside*
that contract — which is the exact seam dustcastle occupies with the Nix Store.

```
HOST (Linux/macOS)
  /nix/store   ← ONE store. The "one place." Deduplicated, content-addressed, immutable.
      │  (mounted read-only)
      ├──► Sandbox A   (sees /nix/store + a tiny ephemeral writable overlay)
      ├──► Sandbox B   (same store, no copy)
      └──► Sandbox C   ...
```

### Two kinds of "dependencies" — don't conflate them

- **Toolchain** → lives in the shared Store. Stable, system-level, shared across
  projects: language runtime, package manager, git, gh, Claude Code, **and system
  libraries** (ffmpeg, libvips, postgres). Never rebuilt per project.
- **Project Deps** → a single repo's lockfile packages (`node_modules`, etc.).
  Unique per project, change with the lockfile. **Nix-built from the lockfile into
  the shared Store by default** ([ADR 0004](docs/adr/0004-project-deps-pure-default-explicit-impurity.md))
  — deduped, reproducible (and run with no network, so untrusted `postinstall` code
  can't exfiltrate). When a dep can't build hermetically, impurity is **policy-gated
  and never silent** (`allow` default → visible marker · `ask` · `deny`), made safe
  by the access controls in [ADR 0005](docs/adr/0005-sandbox-secrets-and-egress.md).

### Ecosystem-agnostic by construction

Every ecosystem is just three slots, so "works for all" falls out of the model
rather than being a special feature:

| Slot | npm/TS | Python | Rust | Go | Ruby |
|---|---|---|---|---|---|
| **Toolchain** (→ Store) | node, pnpm | python, uv | rustc, cargo | go | ruby, bundler |
| **Install deps** (→ Nix-built into Store) | `pnpm i` | `uv sync` | `cargo fetch` | `go mod download` | `bundle install` |
| **Run tests** (sandbox *capability*) | `vitest` | `pytest` | `cargo test` | `go test` | `rspec` |

---

## Why Nix (and not the alternatives)

We surveyed the landscape (twice — once open-ended to avoid confirmation bias). The
decisive property: **only the Nix-store family gives a single content-addressed
store that dedups per-package across all projects, is reproducible, AND covers
system libraries** — mountable read-only into many sandboxes.

| Approach | Shared dedup store | System libs | Reproducible | Verdict |
|---|---|---|---|---|
| **Nix store** | ✅ best (`/nix/store`) | ✅ | ✅ best | **chosen** ([ADR 0001](docs/adr/0001-nix-store-as-the-toolchain-mechanism.md)) |
| devbox / devenv / flox | ✅ (wraps Nix) | ✅ | ✅ | same engine, friendlier surface; flox's "Catalog" is partly a hosted service |
| mise / asdf | 🟡 partial | ❌ runtimes only | 🟡 | not the core |
| devcontainer features | ❌ per-image | ✅ | 🟡 weak | = sandcastle's current per-project-build pain |
| Bazel / Buck2 | ✅ CAS | ⚠️ awkward | ✅ (remote only) | wrong altitude (build system, not dev env) |
| Wasm/WASI | module-level | ❌ today | ✅ | system libs don't run unmodified — watch, don't ship |

**Raw Nix over flox/devbox:** absorbing Nix's complexity behind great UX is
dustcastle's *whole job*, so author-side difficulty is not a downside — and raw Nix
has no external service dependency. We own the engine.

---

## Facts worth knowing

### Platform support (Boundary-dependent)
- **microVM** runs on **Linux** (Firecracker/cloud-hypervisor/QEMU, needs `/dev/kvm`)
  **and macOS** (vfkit / Apple Virtualization.framework — store-sharing via virtiofs
  works, Rosetta runs x86_64 guests). Caveat: building guests on macOS needs a Linux
  builder. **Windows** only via a Linux VM/WSL2.
- **container** runs everywhere incl. Windows.

### Performance: two clocks, don't confuse them
- **First-run provisioning** (pull image + download ~1GB NixOS closure + build):
  *minutes*, but **one-time** — paid once into the shared Store, then cached. This
  is literally dustcastle's pitch demonstrating itself.
- **Boot** (the number that recurs per sandbox start):
  - container: near-instant (no kernel boot, bind-mount = zero copy).
  - microVM: the famous Firecracker "~125ms" is a *minimal-kernel* figure; a real
    full NixOS guest via microvm.nix is **low single-digit seconds** (sources). A
    throwaway prototype confirmed the build path works but was stopped before
    producing an on-box number; the sourced estimate stands.

### Memory (microVM only)
- **Stopped VM = 0 RAM** (just a disk image/snapshot).
- **Running VM** holds its working-set RAM and — unlike a container — doesn't give it
  back elastically ("memory allocation especially inflexible"). virtio-balloon can
  reclaim it but isn't on by default.
- The natural model is **ephemeral sandboxes**: `run()` starts, `close()` tears down
  when the agent task finishes → **no idle RAM**. You only pay idle RAM if you opt
  into a warm pool to dodge boot latency.

---

## Decided

- **Boundary: container for v1** ([ADR 0003](docs/adr/0003-container-boundary-for-v1.md)) —
  Docker/Podman + bind-mounted `/nix/store`. Simpler, faster, portable, lighter on
  RAM, and delivers the full shared-Store vision; the only thing given up is the
  hardware boundary (acceptable for agents on *your own* repos). microVM is the
  documented swappable upgrade for an untrusted-code threat model.
- **Project Deps: pure by default, impurity explicit** ([ADR 0004](docs/adr/0004-project-deps-pure-default-explicit-impurity.md)) —
  deps are Nix-built into the shared Store (reproducible, no-network builds). When a
  dep can't build hermetically, impurity is **policy-gated and never silent**:
  `allow` (default — do it + write a visible, version-controlled marker = async
  consent) · `ask` (y/n once per project; headless falls back) · `deny` (exit). The
  invariant is "you always know whether a Sandbox is reproducible," not "always pure."
- **Sandbox access: default-deny secrets, scoped egress** ([ADR 0005](docs/adr/0005-sandbox-secrets-and-egress.md)) —
  the Sandbox inherits **no** host credentials and egress is scoped/allowlisted, so
  the agent (or a compromised dependency) can't exfiltrate your work secrets. This is
  what makes `allow`-by-default impurity safe: lax-on-purity *because* strict-on-access.
- **Ecosystem detection: an owned lockfile router** ([ADR 0006](docs/adr/0006-ecosystem-detection-owned-lockfile-router.md)) —
  dustcastle detects the Ecosystem itself from the repo's **lockfile** (which names the
  package manager → importer) + version files (`.nvmrc`/`go.mod`…), not via a
  third-party tool — the only detection+Nix tools (nixpacks, dream2nix discovery) are
  dead ends. Loose manifests with no lock-grade input (`requirements.txt`, etc.) are
  **pinned once into a generated lock, then built pure** — impurity only as last resort.
- **Interface: dustcastle is a CLI, and the surface is `dustcastle run`** ([ADR 0002](docs/adr/0002-consume-sandcastle-via-provider-factories.md)) —
  one zero-argument command, **no command to pass**. dustcastle is *not* a test runner:
  `run` kicks off **sandcastle's flow** (agent-in-sandbox orchestration) with the sandbox
  **provisioned from the shared Store instead of a per-project Docker image**. The agent
  inside does the work (incl. running the project's tests — the Ecosystem run-tests slot
  is a sandbox *capability*, not dustcastle's action). Detection, provisioning, session
  reuse, and Store GC are automatic and invisible — the agent never `start`s/`stop`s/`gc`s.
  sandcastle is the library you import for programmatic control; there is no dustcastle SDK.
- **Store lifecycle is dustcastle-managed** ([ADR 0007](docs/adr/0007-store-lifecycle-management.md)) —
  the Store grows with *unique package-versions*, not *projects × deps*, and dustcastle
  keeps it lean with **scoped GC roots** (one per active project, keyed by lockfile hash),
  a **`nix-collect-garbage`** policy, and **`nix store optimise`** (file-level dedup). An
  unmanaged `/nix/store` is the famous 50GB complaint; a managed one is the lean option.
- **Install: a rootless, dustcastle-owned store — and dustcastle is OS-agnostic** ([ADR 0008](docs/adr/0008-rootless-store-install.md)) —
  dustcastle owns a rootless nix-portable-style store (no root daemon required), because
  "install once" must hold on the no-root hosts where agents actually run (CI, sandboxes,
  the spike's own host). Single code path; root-daemon support deferred; relies on
  nix-portable's bwrap→proot auto-fallback, surfacing the active mode. **dustcastle does
  nothing per-OS**: the Store holds Linux binaries that run only inside sandcastle's Linux
  container, so it's intrinsically a Linux artifact. The host just needs a container runtime
  (sandcastle's dependency — on macOS/Windows already a Linux VM); where the container runs
  isn't dustcastle's concern. "Global" = per-user. Build-time no-network isn't kernel-enforced
  rootless (the real boundary is the runtime container's egress, [ADR 0005](docs/adr/0005-sandbox-secrets-and-egress.md)).
- **No config files** ([ADR 0005](docs/adr/0005-sandbox-secrets-and-egress.md)) — there is
  no `dustcastle.toml`. The undetectable settings need no file: impurity defaults to `allow`
  (env var to change), the **egress allowlist is *derived from ecosystem detection*** (the
  detected registry + the repo's git remote), and the ecosystem-override edge case is
  handled by just provisioning the detected toolchain (extra is cheap, deduped). The one
  irreducibly-explicit input — **secret injection** — rides the **environment / a secret-store
  reference**, never a committed file. Config-less stays config-less.

## Open decisions (not yet locked)

1. **Ephemeral vs warm/snapshot pool** — only relevant under the microVM upgrade
   (eat boot latency each run, 0 idle RAM, vs keep VMs warm, instant, costs RAM).

**Deferred (decided not to do for v1):**

- **Curated override set** — v1 ships **no** pre-built Nix overrides for impure packages
  (prisma/sharp/puppeteer/…). The [ADR 0004](docs/adr/0004-project-deps-pure-default-explicit-impurity.md)
  impurity policy carries the full load instead — such packages hit `allow` (impure build +
  visible marker), which is safe under [ADR 0005](docs/adr/0005-sandbox-secrets-and-egress.md).
  Overrides were only ever a tail-shrinker, not load-bearing; revisit if the impure tail proves noisy.

---

## Repo layout

```
CONTEXT.md            glossary — the project's vocabulary
docs/adr/             the decisions and why (0001 Store · 0002 provider factories · 0003 Boundary · 0004 deps & impurity policy · 0005 secrets & egress · 0006 ecosystem detection · 0007 store lifecycle · 0008 rootless install)
```
