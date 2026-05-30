# Project Deps: pure by default, impurity explicit (never silent)

A project's [Project Deps](../../CONTEXT.md) are **Nix-built into the shared Store by default** — hermetic, reproducible, deduplicated. When a dep cannot build hermetically (a `postinstall` that downloads, native modules, private registries), dustcastle neither silently degrades nor hard-exits by default: **impurity is permitted, but never silent**, governed by a policy. The protected invariant is not "always pure" but **"you always know whether a Sandbox is reproducible."**

> Supersedes the earlier strict "fail-hard, no fallback" framing. The real evil we were guarding against was *silent* non-reproducibility, not impurity itself — and for the actual use case (solo, own work repos) a hard exit on prisma/puppeteer rejects real projects for a reproducibility guarantee that isn't needed there.

## How "pure" works (it still uses npm)

"Nix-built" does not mean "no npm." For npm: Nix **fixed-output-fetches** every dependency from the lockfile (pinned by hash) into the Store, then runs **real `npm ci --offline`** against that cache — actual npm, assembling `node_modules`, with **no network**. Same shape for other ecosystems (`buildGoModule`, `crane`, `uv2nix`). The only forbidden thing in pure mode is npm reaching the network *itself* at install time.

## The impurity policy

```
impure = allow | ask | deny
```

| Mode | Behaviour | For |
|---|---|---|
| **`allow` (default)** | Build impurely when needed, and **record it as a visible, version-controlled marker** (a tracked flag in the project's dustcastle config) so it shows up in `git status` / the PR diff. | solo / own-repos flow ([ADR 0005](0005-sandbox-secrets-and-egress.md) makes this safe) |
| **`ask`** | Interactive y/n **once per project**, then cached by lockfile hash. In a **headless** run (no human) it falls back to a configured default — a blocking prompt must never stall an unattended agent. | users who want a hard gate |
| **`deny`** | Exit with an actionable error (the original strict stance). | high-assurance / "reproducible-store" identity |

The marker is the key: `allow` is **asynchronous consent**, not silent default. Instead of a blocking prompt, impurity surfaces as a diff you review on your own time — non-blocking (autonomy preserved) yet never hidden.

## Why pure-by-default (beyond reproducibility)

A pure build runs in a **no-network sandbox**, so untrusted `postinstall` code **cannot phone home or exfiltrate during the build**. That is a *security* benefit, and a stronger reason to prefer pure than reproducibility alone. It also means `allow` mode (which runs untrusted code *with* network) is only safe alongside the access controls in [ADR 0005](0005-sandbox-secrets-and-egress.md): lax-on-purity is acceptable *because* we are strict-on-access.

## Relevant Nix features (verified 2026)

Both experimental as of Nix 2.34 ([Nix experimental features](https://nix.dev/manual/nix/2.34/development/experimental-features.html)):

- **`dynamic-derivations` — adopt.** Generates derivations at build time, *"enabling IFD-less lang2nix implementations"* ([nix-ninja](https://github.com/pdtpartners/nix-ninja/blob/main/docs/dynamic-derivations.md)) — lockfile → deps with no `npmDepsHash`-regeneration step. Serves the "all dynamic" goal.
- **`impure-derivations` — the mechanism behind `allow` mode.** It grants a build network access with a non-fixed (non-reproducible) output. We do **not** use it silently or by default — it is *only* how an explicitly-marked impure build is implemented. (Earlier this ADR rejected it outright; under the explicit-marker policy, using it *transparently* is consistent with "never silently impure.")

## Considered Options

- **Strict / `deny`-only (no fallback, exit).** Max integrity; rejects real npm projects. Kept as the `deny` mode, not the default.
- **Impure silent by default.** Max coverage; but silent non-reproducibility is the exact evil. Rejected — `allow` differs only by the *visible marker*, which is the whole point.
- **Pure-only (never impure).** Forfeits coverage entirely. Rejected.

## Consequences

- For clean ecosystems (Go, Rust) you get Store dedup + reproducibility for free; for the npm/native long tail, `allow` keeps things moving with a visible marker.
- Curated overrides (skip-impure-script + supply-as-Nix-input, the documented nixpkgs pattern) let many "impure" packages build *purely* anyway — shrinking how often `allow` is even needed. **v1 ships none of these** (deliberate scope call): the policy carries the full load, so impure packages hit `allow` rather than building purely via an override. Overrides were only ever a tail-shrinker; revisit if the impure tail proves noisy.
- `allow` being the default is **only safe with [ADR 0005](0005-sandbox-secrets-and-egress.md)** (no host credentials in the Sandbox + scoped egress).
- Depends on reliable Ecosystem detection (still an open design point) to pick the importer.
