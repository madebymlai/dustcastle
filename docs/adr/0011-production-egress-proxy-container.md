# Making the production egress proxy container actually run

## Status

accepted — refines [ADR 0005](0005-sandbox-secrets-and-egress.md) (the podman-native production egress backend) and [ADR 0010](0010-agent-llm-egress.md) (Agent Egress over the same proxy).

## Context

ADR 0005 specified the production confinement as a `--internal` podman network plus a dual-homed filtering-proxy container, but only its *spec generators* (`confine.ts`) were unit-tested — the live run was deferred to "a capable host" because this machine's rootless podman could not create a bridge network. The first live run (after a kernel reboot restored rootless bridging) exercised the podman-native backend end-to-end for the first time and exposed three gaps that each silently broke egress:

1. **The proxy had no way to load its own code.** `ensureEgress` ran stock `node:20-alpine` with `node /opt/dustcastle/proxy-main.js`, but nothing ever put `proxy-main.js` into that image — only the agent image was built/shipped. The container crashed on start with `ERR_MODULE_NOT_FOUND`.
2. **`podman run -d` exits 0 when the container is *created*,** not when its process survives. So a crashed proxy passed `ensureEgress`'s success check and the allowlist was logged as "enforcing" over a dead proxy — a silent success, violating ADR 0005's "never silent."
3. **A loopback bind + aardvark DNS made a *running* proxy non-functional.** `proxy-main` defaults to binding `127.0.0.1` (correct for the host-side fallback, where pasta maps loopback in), but the production proxy is its own container reached by a *separate* sandbox container over the internal net — loopback refuses those connections. And once dual-homed onto the `--internal` network, the container's only resolver is that network's aardvark, which returns NXDOMAIN for off-host names; under the proxy image's musl libc (parallel queries, first-answer-wins) that NXDOMAIN poisons resolution, so the proxy could not resolve the very registries it was meant to reach.

## Decision

- **dustcastle owns the proxy image** (`ensureProxyImage`, mirroring `ensureAgentImage`): a one-time `podman build` of `proxy.Containerfile` (`FROM node:20-alpine`, `COPY proxy.js proxy-main.js /opt/dustcastle/`), shipped into `dist/sandbox/` by `copy-assets.mjs`. The proxy is dependency-free (node builtins only), so `COPY`-into-image keeps the container self-contained and host-path-independent — preserving the "host-OS-agnostic, podman-only" property. Built lazily on the allowlist path only.
- **`ensureEgress` verifies the proxy is *serving*, not merely created** — it polls the container's logs for the `listening on …` line `proxy-main` prints once bound, and fails fast (rolling back the container + the network it created) with the container's output if the proxy exited instead. A dead proxy is never a silent success.
- **The production proxy container binds `0.0.0.0`** (`DUSTCASTLE_EGRESS_HOST=0.0.0.0` in `proxyContainerRunArgs`) so the sandbox can reach it across the internal net. The host-side fallback keeps `proxy-main`'s loopback default.
- **The proxy resolves allowlisted hosts through external resolvers, not the internal aardvark** — `ensureEgress` materializes a small resolv.conf (`nameserver 1.1.1.1` / `8.8.8.8`, see `EGRESS_PROXY_DNS`) under the dustcastle home and bind-mounts it at the proxy's `/etc/resolv.conf:ro`. The sandbox's own resolv.conf is untouched, so it still resolves the proxy *by name* via the internal aardvark. The hostname allowlist is enforced *before* any DNS lookup, so the resolver choice never widens what the proxy will connect to.

## Consequences

- The podman-native production backend is now **proven live** (image carries the proxy code; `0.0.0.0` bind reachable cross-container; external DNS resolves; allowlisted hosts `CONNECT 200`, off-allowlist `403`, and an internal-net client has no route off-host). The two-backends-one-proxy design holds; this was purely about shipping the proxy code and giving its container a working bind + resolver.
- The proxy now depends on a reachable public DNS resolver (`1.1.1.1`/`8.8.8.8`). On a host where those are blocked but a corporate resolver works, `EGRESS_PROXY_DNS` needs to become configurable; for now it is a constant with a sane default.
- `ensureProxyImage` adds a second one-time image build (alongside `ensureAgentImage`); idempotent thereafter via `podman image exists`.

## Amendment: one `confine()` facade owns derivation + enforcement + posture

The egress guarantee was spread across four shallow modules, and the same decisions were re-stated in several of them: `egress.ts` (derive the allowlist), `confine.ts` (pure spec generators — network name, proxy URL, `proxyEnv`, container args), `egress-runtime.ts` (`ensureEgress`: bring the proxy up + verify alive), and the caller (`run/index.ts`, whose `beforeProvision` block built the proxy image, wrote the resolv.conf, and chose the entrypoint). Symptoms: the `egress.kind` allowlist/none branch was interpreted in `plan.ts`, `egress-runtime.ts`, **and** `run/index.ts`; the proxy address was derived twice (`plan.ts` and the `ensureEgress` handle) and never reconciled, agreeing only because both called `productionProxyUrl()`; and `deriveEgress` had two call sites whose copies disagreed (`plan.ts`'s fallback omitted the git host, git-dep hosts, and the agent host). "Is the Sandbox confined to the allowlist?" had no single owner and no single test surface.

**Decision: a single `confine()` facade owns the whole guarantee.** `egress.ts` + `confine.ts` + `egress-runtime.ts` merge into one `sandbox/egress` module whose only public surface is `confine(input) → Confinement { decision, posture, enforce() }`:

- `confine()` does all derivation internally (git remote host, git-dep scan, `deriveEgress` — now the **only** call site), computes the Sandbox's network **posture** (`{ network, env }`), and resolves the proxy address **once** (`input.proxyAddress ?? productionProxyAddress()`).
- `posture` is what the Sandbox plan drops into its podman options; the plan no longer imports any egress internal or branches on `egress.kind`.
- `enforce()` brings up the **production backend only** (image → resolv.conf → `--internal` network → proxy → verify-alive) and returns `{ teardown }`. Liveness is the facade's **tested invariant**: `enforce()` throws if the proxy is not serving.
- Only the facade may branch on `egress.kind` or name the proxy mechanics (network, URL, env, image, entrypoint, resolv.conf); the spec generators stop being public.

**The two backends are unchanged, but the seam is not a runtime switch.** `enforce()` is the production (`--internal` net + dual-homed proxy container) backend. The privilege-stripped-host backend (pasta route-strip) is **composed** from the facade's public pure helpers (`confineRouteScript` + `startEgressProxy`) by whatever needs it — today only the slice-3 e2e — consistent with [ADR 0005](0005-sandbox-secrets-and-egress.md)'s "no unconfined production fallback": production has exactly one confinement backend, and if it cannot stand up the run aborts. The route-strip is a way to *prove* the guarantee on a host that cannot create a bridge, not a production runtime path — so it is not pulled into `enforce()` as a "second adapter."

**Consequences:**

- The caller's `beforeProvision` block collapses to a single `confinement.enforce()`. `prepareRun` owns `confine()` (so `prepareWorkspace`'s reuse still derives a posture without standing up a proxy), and the `withProvisionedSandbox` bracket owns enforce + teardown — its ordering invariant (egress up → … → teardown) is untouched.
- `EgressHandle` stops carrying `proxyUrl` (vestigial — never read on the production path). `ProvisionOptions.proxyImage` / `proxyEntrypoint` are removed (set by no caller); the former proxy-URL override enters through `confine`'s `proxyAddress` input (surfaced by `PrepareOptions.proxyAddress`) — one resolved address, not a second source of truth.
- Egress derivation has one call site, so the plan can no longer build a narrower allowlist than the run enforces.
