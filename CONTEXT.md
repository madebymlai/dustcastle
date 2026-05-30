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
The packages declared by a single project's manifest + lockfile, unique to that project and changing whenever the lockfile does. Distinct from the Toolchain; Nix-built from the lockfile into the Store by default (hermetic, reproducible). When a dep can't build hermetically, dustcastle goes impure only via an explicit, marked policy — never silently (see ADR 0004).
_Avoid_: dependencies (ambiguous — always qualify as Project Deps or Toolchain)

**Warm / cold**:
A closure is **warm** when it is resident in the Store, so a Sandbox that wants it gets it instantly; it goes **cold** when GC collects it, so the next use pays a rebuild or re-fetch. dustcastle keeps a recently-used set warm and lets the rest go cold under disk pressure — the trade-off automatic GC manages on the user's behalf (see ADR 0007).
_Avoid_: cached / evicted (reserve the precise warm/cold pair)

**Ecosystem**:
A language world (npm/TS, Python, Rust, Go, Ruby, …) defined by three slots: a Toolchain (resolved from the Store), an install-deps command, and a run-tests command. dustcastle is Ecosystem-agnostic; sandcastle was biased to npm/TS. Which Ecosystem(s) a repo *is* — and therefore which Nix importer to run — dustcastle detects itself from the repo's lockfile and version files, not via a third-party tool (see ADR 0006). An Ecosystem owns the **detection** grain: how to recognise itself in a directory, how to resolve which of its Package Managers a repo uses, and how to read its Toolchain version.
_Avoid_: language, stack, platform

**Package Manager**:
The specific tool *within* an Ecosystem that owns a repo's dependency resolution — npm/pnpm/yarn/bun for node, `go` for Go, uv/poetry/… for Python. Identified by the lockfile (the lockfile names the Package Manager, which is what selects the Importer; see ADR 0006). The Package Manager is the **dispatch** grain: store provisioning, the impurity signal, and pin-then-pure resolve are all keyed on it. One Ecosystem may have several (node has four); a single one (Go) is still a Package Manager, not a special case.
_Avoid_: manager, tool, pm (in prose)

**Importer**:
The Nix expression generator that builds one Package Manager's Project Deps into the Store — `buildGoModule`, `fetchNpmDeps`/`fetchPnpmDeps`/`fetchYarnDeps`. Derived 1:1 from the Package Manager (npm → `fetchNpmDeps`), so it is a *property of* the Package Manager, not a second key. The borrowed Nix-community term (uv2nix, gomod2nix); each Importer fixed-output-fetches the lockfile's deps (hash-pinned) and assembles them offline (ADR 0004).
_Avoid_: builder, generator, lang2nix (reserve "Importer")

**Ecosystem Registry**:
The single, closed, internally-curated set of Ecosystem + Package Manager descriptors that the detect/store/impurity/pin/nix/sandbox sites all *derive* from, so per-Ecosystem knowledge is owned in one place rather than smeared across dispatch sites. **Internal curation, not a user-facing plugin system** (ADR 0001): closed and vetted, so adding an Ecosystem is dustcastle's deep, local change — the user never configures one. A gated Package Manager (the bun gate) is a first-class, honest state in the Registry, not an ad-hoc throw.
_Avoid_: catalog, plugin system, provider registry

### Network access (ADR 0005 / 0010)

**Egress**:
What a Sandbox can reach over the network — always an **allowlist** enforced by a filtering proxy, never unrestricted internet (ADR 0005). It is the union of two independently-derived sources, **Build Egress** and **Agent Egress**; a pure build with no agent reaches nothing at all (`none`). The proxy receives only the deduped union — the build/agent split is provenance for humans, not something the proxy sees.
_Avoid_: network access, internet (reserve "Egress")

**Build Egress**:
The hosts the *build itself* needs — the package registry the Package Manager names, plus the repo's git host — derived from detection (ADR 0006), present **only on an impure build**. A pure build's Project Deps are pre-assembled offline in the Store, so it needs no Build Egress at all. This is ADR 0005's original derived allowlist.
_Avoid_: build network, registry allowlist

**Agent Egress**:
The single host the *coding agent itself* needs — its model provider's API endpoint, mapped from pi's configured `provider/model`. Present whenever an agent will run, **regardless of build purity**. The carve-out (ADR 0010) that lets the in-sandbox agent reach its LLM even on a pure, offline build: the build still reaches no host it would ever use (registries/git stay blocked), but the agent reaches its model. Distinct from Build Egress because the agent's need has nothing to do with how deps were built.
_Avoid_: LLM access, model network, provider allowlist
