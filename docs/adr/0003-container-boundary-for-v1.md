# Container Boundary for v1; microVM as a swappable upgrade

dustcastle's v1 isolation Boundary is a **container** (Docker/Podman) via sandcastle's `createBindMountSandboxProvider`, with the host `/nix/store` bind-mounted read-only and the worktree bind-mounted (zero copy). The shared-Store vision ([ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md)) is **orthogonal to the Boundary**, so we ship dustcastle's novel value on the simplest, fastest, most portable boundary first, and keep the microVM as a documented swappable upgrade ([ADR 0002](0002-consume-sandcastle-via-provider-factories.md)) for when the threat model demands a hardware wall.

## Why container for v1

- **Simplest** — bind-mount `/nix/store` RO + bind-mount the worktree. No KVM, no virtiofs daemon, no guest NixOS build, no `--privileged`. (A throwaway prototype to even *boot* a microVM hit version-pin, virtiofs, privileged, and eval friction — empirical evidence of the complexity gap.)
- **Fastest** — no kernel boot (near-instant start), bind-mount = zero-copy worktree.
- **Most portable** — Linux, macOS, **and Windows**.
- **Lightest** — RAM is elastic; nothing reserved per sandbox.
- **Same novel value** — the shared Store, any-ecosystem, "one place" benefit is identical to the microVM case, because the Store is orthogonal to the Boundary.
- **Matches the real threat model** — the agent works on *your own* repos (scoped, mostly-trusted), not arbitrary untrusted code.

## Trade-off accepted (the honest cost)

A container shares the host kernel — *"not a security boundary"* against genuinely untrusted/malicious code (Edera, KubeCon EU 2026), and bind-mounting host paths weakens it further. We accept this for v1 given the threat model. It is a **swappable** decision, not a foundational one ([ADR 0002](0002-consume-sandcastle-via-provider-factories.md)): the Boundary lives behind sandcastle's provider-factory seam, so upgrading does not rearchitect dustcastle.

## Considered Options

- **microVM now** — hardware-enforced boundary, but slower (~seconds to boot), heavier (reserved RAM), KVM/vfkit-bound, and far more complex. Deferred to the upgrade path below.
- **gVisor** — tighter software boundary (~50ms, GPU-friendly) that breaks on unimplemented syscalls. A possible alternative upgrade between container and microVM.

## Future upgrade: microVM (verified research, retained)

When the threat model needs a hardware boundary, swap to `createIsolatedSandboxProvider` with a local microVM (microvm.nix). Rationale, in the project's own words: containers share *"one shared Linux kernel with a huge attack surface,"* while VMs *"run their own OS kernel, reducing the attack surface to the hypervisor"* ([microvm.nix](https://microvm-nix.github.io/microvm.nix/)). What we verified:

- **Store sharing — mount, don't bake.** Mount the host `/nix/store` via virtiofs (tag `ro-store` → guest `/nix/.ro-store`, presented as `/nix/store`) + a small ephemeral writable overlay. **Not** a prepopulated per-guest store image — that silently reintroduces the per-project duplication [ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md) exists to kill.
- **Platform:** Linux (Firecracker/cloud-hypervisor/QEMU, needs `/dev/kvm`) and macOS (vfkit / Apple Virtualization.framework — virtiofs store-sharing works, Rosetta runs x86_64 guests; *building* guests on macOS needs a Linux builder). Windows only via a Linux VM/WSL2.
- **Performance:** the headline Firecracker "~125ms" is a *minimal-kernel* figure; a real full NixOS guest is **low single-digit seconds** (sources: [kraftnix](https://kraftnix.dev/blog/why-you-should-use-microvm-nix/), [Northflank](https://northflank.com/blog/firecracker-vs-cloud-hypervisor)). A throwaway prototype confirmed the build path works but was stopped before producing an on-box number; this sourced estimate stands.
- **Memory:** a *running* VM holds its working-set RAM and doesn't release it elastically; a *stopped* VM costs 0. Ephemeral sandboxes (`run()`/`close()`) mean no idle RAM; a warm/snapshot pool trades RAM for instant start.
- **Prior art:** sandboxing a coding agent with microvm.nix already exists ([buduroiu.com](https://buduroiu.com/blog/openclaw-microvm/)).

## Consequences

- Project Deps are **Nix-built into the shared Store** ([ADR 0004](0004-project-deps-pure-default-explicit-impurity.md)) and bind-mounted read-only with the rest of the Store — not installed ad-hoc per sandbox. The only runtime-install case is the impure `allow` path (which does touch network), and under bind-mount that's trivial — the shared package-manager cache is just another bind-mount, unlike the isolated-guest case, which needs a separate virtiofs mount.
- The `--privileged` flag and KVM requirement that the microVM path needs are avoided entirely in v1.
