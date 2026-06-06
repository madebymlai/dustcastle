# Agent LLM egress: the model endpoint is reachable even on a pure build

>Status: retired by [ADR 0020](0020-remove-scoped-egress.md). The Sandbox now uses normal network access, so model-provider host derivation and Agent Egress allowlisting no longer exist.

## Status

accepted — amends [ADR 0005](0005-sandbox-secrets-and-egress.md) ("pure-mode builds run with no network at all").

## Context

The coding agent (pi) runs **inside the same Sandbox** as the build it drives — it shells out `npm test`, `go test`, etc. in its own container. ADR 0005 closes a pure build's network entirely (`network: none`) for reproducibility and exfiltration safety. But the agent must reach its model provider's API to function at all; with the network closed, its LLM calls fail (`Connection error`, 0 tokens → empty output → the orchestration loop dies before it starts). Pure-build purity and "the agent needs its LLM" are in direct tension.

The agent and the build share one network namespace, so we cannot give the build no network while the agent gets egress by network isolation — that would require running build commands in a different container from the agent, a deep change to how sandcastle executes an agent run.

## Decision

Carve the agent's own model endpoint out of the pure-build network posture, as a second, independent source of egress:

- **Egress** is the union of **Build Egress** (the registry + git host the *build* needs, derived from detection, impure-only) and **Agent Egress** (the *agent's* model-provider API host, present whenever an agent will run, regardless of build purity). Both feed one filtering-proxy allowlist; a pure build with no agent still reaches nothing (`none`).
- When a model is configured (⇒ an agent will run), the Sandbox attaches the `--internal` egress network with the model host allowlisted, **even on a pure build**. The proxy remains the only route off-host and allows *only* the union of derived hosts — never a wildcard.
- The model host is mapped from pi's `provider/model` via a hand-maintained `PROVIDER_HOSTS` map (`deepseek → api.deepseek.com`, …). An **unknown provider throws at plan time** with an actionable message, rather than letting the agent fail mid-run with a cryptic connection error (never-silent, ADR 0005).
- Build purity (how Project Deps are staged) is decided **independently of egress** — from whether the deps were realized into the Store (`provisioned.depsStorePath`), not from the egress decision's shape. Egress means only "what the network can reach," never "how deps are installed."

## Consequences

- A pure build's guarantee weakens from "no network at all" to "**only the agent's own model endpoint** — nothing the build would ever use." Registries and the git host stay blocked, and build tooling never targets the model host, so the build remains effectively offline; but the absolute `network: none` guarantee no longer holds once an agent is present.
- `PROVIDER_HOSTS` needs per-provider maintenance — the same curated-allowlist upkeep ADR 0005 already accepts for registries.
- On an **impure** build the agent's model credential (`~/.pi/agent`, mounted unconditionally) is co-resident with untrusted `postinstall` code that already had registry/git egress; adding the model host is a marginal increase in that pre-existing surface. On a **pure** build no untrusted code runs, so the agent is the sole user of Agent Egress.
- Confinement depends on pi honouring `HTTP(S)_PROXY` (the `--internal` network has no direct route off-host). This is the live-verification risk for the carve-out, the same proxy mechanism the impure-build path already relies on.
