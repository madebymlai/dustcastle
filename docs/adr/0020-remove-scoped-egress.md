# Remove scoped egress

Status: accepted

## Decision

dustcastle is a toolchain/deps manager, not a containment sandbox. The Sandbox keeps the container Boundary for host protection, but dustcastle no longer derives or enforces scoped network egress. Containers use normal network access.

## Why

Scoped egress defended exactly one threat: a supply-chain-compromised dependency exfiltrating over the network from inside the Sandbox. For dustcastle's actual use — an operator running their own repos with mainstream deps they already `pip install` / `npm install` unsandboxed on the host — that install code already runs on the host with full network and real credentials, so a Sandbox without egress is still strictly safer than the status-quo baseline (the host filesystem stays protected). Against that thin marginal benefit, egress was the single most complex subsystem in the codebase (a proxy container per run, allowlist derivation, per-ecosystem git-dep host detection, liveness polling, fail-fast teardown). The project's YAGNI principle — "if no concrete use case exercises it today, delete it" — settles it. Removing it also dissolves the per-ecosystem git-dep host-derivation problem, which existed only to feed the allowlist.

## Consequences

- **Open network is the accepted trade-off.** Anything inside the Sandbox — the agent, or any third-party dependency install code (`postinstall`, `build.rs`, proc-macros) — can exfiltrate whatever it can read (the source tree, the mounted `~/.pi/agent` login, any injected Credential) to any host. This is acceptable under the trusted-deps / own-repos model; it is **not safe for pointing dustcastle at code you do not trust**. Reversing it means rebuilding the proxy + allowlist derivation — a non-trivial cost, which is why this is an ADR.
- No filtering-proxy image or container is built or started.
- `planSandbox` does not set proxy environment variables and does not override podman network mode.
- Runs no longer derive build, git-dependency, or model-provider allowlists.
- [ADR 0010](0010-agent-llm-egress.md) and [ADR 0011](0011-production-egress-proxy-container.md) are retired.
- [ADR 0005](0005-sandbox-secrets-and-egress.md) decision 2 is superseded; default-deny host credentials and the container Boundary remain.
