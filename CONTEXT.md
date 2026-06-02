# dustcastle

A global toolchain manager for AI coding agent sandboxes. It backs every project's sandbox with one shared, deduplicated Nix store instead of per-project image builds — installed once, used everywhere, across any language ecosystem. Under the hood it uses [sandcastle](https://github.com/mattpocock/sandcastle)'s `createBindMountSandboxProvider` / `createIsolatedSandboxProvider` to actually stand up sandboxes; that is an implementation detail, not dustcastle's identity.

## Language

**Store**:
The single, content-addressed Nix store (`/nix/store`) that every project's Sandbox draws its Toolchain from. Immutable and deduplicated, so it can be shared read-only into many Sandboxes at once. This is dustcastle's "one place" — what you install once and never tend; dustcastle owns its lifecycle (automatic GC, optimise, scoped roots) so it stays lean on its own, without the user ever worrying about disk or "files" (see ADR 0007). dustcastle owns it rootlessly (no root daemon; see ADR 0008), so "global" means **per-user**. The Store holds Linux binaries that only ever run inside the Sandbox's Linux container, so it's intrinsically a Linux artifact and dustcastle is OS-agnostic — the host just needs the container runtime sandcastle already requires.
_Avoid_: catalog, registry, image library

**Provider**:
A sandcastle sandbox provider that dustcastle constructs via the library's `createBindMountSandboxProvider` or `createIsolatedSandboxProvider` factories to stand up a Sandbox from the Store. A mechanism dustcastle *uses*, not what dustcastle *is*. The factory choice selects the Boundary: bind-mount → container, isolated → microVM.

**Sandbox**:
The running, isolated environment an agent works inside, stood up by the Provider with the Store mounted in and the project's source available. (Term inherited from sandcastle.)

**Boundary**:
The isolation mechanism separating a Sandbox from the host. A container boundary (Docker/Podman — software, shared kernel) or a microVM boundary (Firecracker — hardware, own kernel). Orthogonal to the Store: the Store mounts in read-only under either.
_Avoid_: isolation, jail, sandbox (reserve "Sandbox" for the environment itself)

**Toolchain**:
The stable, shared, system-level software an Ecosystem needs — language runtime, package manager, git, gh, Claude Code, and system libraries (ffmpeg, libvips, postgres). Resolved from the Store, never rebuilt per project.
_Avoid_: system deps, base deps

**Project Deps**:
The packages declared by a single project's manifest + lockfile, unique to that project and changing whenever the lockfile does. Distinct from the Toolchain: dustcastle installs them by running the repo's own Package Manager (impure — the real install, lifecycle scripts and all), then **caches the assembled result keyed by lockfile hash** so a repeat Sandbox restores it instead of re-installing (see ADR 0012). Not built into the Store and not byte-reproducible — dustcastle does not trade on hermetic deps.
_Avoid_: dependencies (ambiguous — always qualify as Project Deps or Toolchain)

**Warm / cold**:
An entry is **warm** when it is resident, so a Sandbox that wants it gets it instantly; it goes **cold** when GC collects it, so the next use pays a re-fetch or re-install. This applies to **both** managed pools — the Store (Toolchain closures) and the deps cache (assembled Project Deps keyed by lockfile hash) — kept warm by one recency/ceiling brain that lets the rest go cold under disk pressure (see ADR 0007/0012).
_Avoid_: cached / evicted (reserve the precise warm/cold pair)

**Ecosystem**:
A language world (npm/TS, Python, Rust, Go, Ruby, …) defined by three slots: a Toolchain (resolved from the Store), an install-deps command, and a run-tests command. dustcastle is Ecosystem-agnostic; sandcastle was biased to npm/TS. Which Ecosystem(s) a repo *is* — and therefore which install command to run — dustcastle detects itself from the repo's lockfile and version files, not via a third-party tool (see ADR 0006). An Ecosystem owns the **detection** grain: how to recognise itself in a directory, how to resolve which of its Package Managers a repo uses, and how to read its Toolchain version.
_Avoid_: language, stack, platform

**Package Manager**:
The specific tool *within* an Ecosystem that owns a repo's dependency resolution — npm/pnpm/yarn/bun for node, `go` for Go, uv/poetry/… for Python. Identified by the lockfile (the lockfile names the Package Manager, which is what selects the **install command** and **registry host**; see ADR 0006/0012). The Package Manager is the **dispatch** grain: its install command, its registry host, and its staging are all keyed on it. One Ecosystem may have several (node has four); a single one (Go) is still a Package Manager, not a special case.
_Avoid_: manager, tool, pm (in prose)

**Install command**:
What dustcastle runs to assemble one Package Manager's Project Deps — the real Package Manager, frozen to the lockfile when present (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync`, `cargo build`), resolving when not. Derived 1:1 from the Package Manager, so it is a *property of* the Package Manager, not a second key. It runs in-Sandbox via the sandcastle hook, and its assembled output is what the deps cache stores (ADR 0012).
_Avoid_: importer, builder, lang2nix (no Nix dep-expression generator exists any more)

**Ecosystem Registry**:
The single, closed, internally-curated set of Ecosystem + Package Manager descriptors that the detect/store/sandbox/egress sites all *derive* from, so per-Ecosystem knowledge is owned in one place rather than smeared across dispatch sites. **Internal curation, not a user-facing plugin system** (ADR 0001): closed and vetted, so adding an Ecosystem is dustcastle's deep, local change — the user never configures one. There are no gated managers: a Package Manager dustcastle can't build hermetically is no longer a special state, because every manager installs impurely (ADR 0012).
_Avoid_: catalog, plugin system, provider registry

### Network access (ADR 0005 / 0010)

**Egress**:
What a Sandbox can reach over the network — always a default-deny **allowlist** enforced by a filtering proxy, never unrestricted internet (ADR 0005). It is a **standing** allowlist of three hosts: the package registry the Package Manager names, the repo's git host, and the agent's model endpoint (ADR 0010/0012). No longer derived per build-purity — every Sandbox installs deps with the network on, so the registry + git are always present. The **Build Egress** / **Agent Egress** split below is provenance for humans, not something the proxy sees.
_Avoid_: network access, internet (reserve "Egress")

**Build Egress**:
The hosts the *dep install* reaches — the package registry the Package Manager names (the `registryHost` on its Ecosystem Registry descriptor), plus the repo's git host. The install runs **in-Sandbox** via the sandcastle hook, so these are a standing part of the allowlist (ADR 0012), not derived or conditional. `registryHost` is **required** on every Package Manager descriptor (go/cargo included), so it stays exhaustive at `tsc`.
_Avoid_: build network, registry allowlist

**Agent Egress**:
The single host the *coding agent itself* needs — its model provider's API endpoint, mapped from pi's configured `provider/model` (ADR 0010). Present whenever an agent will run. Distinct from Build Egress because the agent's need is its LLM, not the dep registry.
_Avoid_: LLM access, model network, provider allowlist
