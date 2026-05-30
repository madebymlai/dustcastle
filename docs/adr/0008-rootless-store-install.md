# Rootless store: dustcastle owns a nix-portable-style store, not a root-daemon Nix

dustcastle's install mechanism for v1 is a **rootless, dustcastle-owned Nix store** (nix-portable style — a static binary, physical store under a dustcastle-owned per-user dir, presented at `/nix/store` via a user namespace) rather than requiring a root-daemon Nix install. **Single code path**; opportunistic use of an existing root-daemon Nix is deferred. This is what lets "install once" actually hold on the hosts where agents run.

## Why rootless is the floor, not a fallback

"Install once **globally**" assumes you *can* install — but agent sandboxes, CI runners, and locked-down hosts routinely **lack root**. The Go vertical spike's host was one: no Nix, no sudo, `/` not writable. That isn't an edge case — it's the target environment. Requiring a root daemon ([option A](#considered-options)) breaks the core promise exactly where it matters most.

The spike collapsed the apparent difficulty: **the bind-mount works identically whether the store is a root `/nix/store` or a rootless `~/.../nix/store`** — the store is just real, content-addressed files on disk, mounted read-only into the Sandbox. Rootless adds exactly one thing dustcastle absorbs: a **host-side path-prefix translation** when staging (`/nix/store/X` → physical `…/nix/store/X`). Inside the container the path is the canonical `/nix/store/…`. That seam is internal; it never reaches the user or the agent.

## The user-namespaces sub-decision

nix-portable presents the store at `/nix/store` via a **bwrap user namespace**, which needs **unprivileged user namespaces** enabled — and a slice of the very locked-down hosts we chose this for *disable* them (hardened kernels, some RHEL, restrictive seccomp). nix-portable already handles this by auto-falling-back **bwrap → proot** (ptrace-based, needs no userns, works on essentially any Linux, but substantially slower).

**Decision: rely on that built-in bwrap→proot auto-detection, accept the proot slow-path as the price of universal reach, and *surface* which mode is active** — never silently degrade. The proot cost hits *host-side build/staging*, not the runtime container (which uses a plain RO bind-mount, no proot inside), and it's the already-"minutes, one-time" provisioning clock ([ADR 0003](0003-container-boundary-for-v1.md)) — paid once into the store, then cached. Surfacing the active mode keeps faith with the "never silently" invariant running through [ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)/[ADR 0005](0005-sandbox-secrets-and-egress.md).

## dustcastle is OS-agnostic — the Store is a Linux artifact in sandcastle's container

dustcastle writes **no per-OS code**, and that isn't a feature we engineered — it falls out of what dustcastle *is*. The Store holds the Toolchain and Project Deps, which are **Linux binaries** that run inside the Linux container **sandcastle** stands up. They never execute on the host OS. So the Store is intrinsically a **Linux artifact living in the container world**, whether the host is Linux, macOS, or Windows.

The host OS's only job is to run a container runtime — and that is **sandcastle's dependency, not dustcastle's**. sandcastle drives Docker/Podman; on macOS/Windows that already means a Linux VM (Docker Desktop / `podman machine` / WSL2). dustcastle is indifferent to all of it: it builds Linux Store paths and hands sandcastle the mount ([ADR 0002](0002-consume-sandcastle-via-provider-factories.md)'s `mounts` array); *where* the container runs is the runtime's concern, identical to any container tool.

| Host OS | What dustcastle does differently |
|---|---|
| Linux | nothing |
| macOS | nothing |
| Windows | nothing |

The only genuinely host-varying detail is *where the Store files sit so the container can mount them* — on Linux, the host filesystem; on macOS/Windows, inside the runtime's Linux VM. That's a mount-location detail, handled by the same one rootless mechanism, not per-OS dustcastle logic. The costs there are the container runtime's, not dustcastle's: the VM's RAM on Mac/Windows (true of any container workflow, already accepted in [ADR 0003](0003-container-boundary-for-v1.md)), and a per-machine Store (consistent with "global = per-user").

## "Global" means per-user in rootless mode

An honest scope-narrowing: a rootless store is **per-user**, not machine-wide. "Install once globally" = **per-user-global** — two users on one box don't share the store, losing some cross-user dedup. Acceptable (agents typically run as one service user); stated so it isn't a surprise.

## Considered Options

- **A — require a root-daemon Nix.** The canonical multi-user install: kernel-enforced no-network build sandbox, best perf, canonical paths, standard tooling. **Rejected for v1** — needs root to install, so it fails on exactly the no-root hosts agents run on, breaking "install once."
- **C — support both, prefer root, fall back to rootless.** The eventual right answer (use the stronger guarantee + perf when a root daemon is present). **Deferred** — it's two code paths and a v2 optimization, not a v1 gate, and edges toward a silent-mode fallback unless carefully surfaced. B is the single-path floor C would build on.

## Consequences

- **dustcastle bundles/manages the rootless Nix runtime** and owns the physical store dir per-user. (Bundle-vs-download the static binary is an implementation detail, not decided here.)
- **The build-time no-network guarantee is mode-dependent and weaker than root.** Rootless does not kernel-enforce a no-network build sandbox; pure-build offline-ness rests on tooling (`GOPROXY=off`, `-mod=vendor`, fixed-output fetch hashes). This is acceptable because the **real security boundary is the runtime container's scoped egress + default-deny secrets** ([ADR 0005](0005-sandbox-secrets-and-egress.md)), enforced regardless of Nix install mode, under ADR 0003's "your own repos" threat model. dustcastle must be able to *surface* that it's in the weaker-build-isolation mode — not pretend it's as hermetic as root.
- **The path-translation seam is internal** — host-side staging only; the container and the agent never see it.
- **A minimal base image suffices.** The spike showed a stock `debian:bookworm` works because the Nix closure carries its own glibc/std — reinforcing that the image stops mattering once the toolchain comes from the store.
- Provider integration is unaffected — the store mounts via sandcastle's public `mounts` array either way ([ADR 0002](0002-consume-sandcastle-via-provider-factories.md)).
