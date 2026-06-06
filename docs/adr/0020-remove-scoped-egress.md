# Remove scoped egress

Status: accepted

## Decision

dustcastle is a toolchain/deps manager, not a containment sandbox. The Sandbox keeps the container Boundary for host protection, but dustcastle no longer derives or enforces scoped network egress. Containers use normal network access.

## Consequences

- No filtering-proxy image or container is built or started.
- `planSandbox` does not set proxy environment variables and does not override podman network mode.
- Runs no longer derive build, git-dependency, or model-provider allowlists.
- [ADR 0010](0010-agent-llm-egress.md) and [ADR 0011](0011-production-egress-proxy-container.md) are retired.
- [ADR 0005](0005-sandbox-secrets-and-egress.md) decision 2 is superseded; default-deny host credentials and the container Boundary remain.
