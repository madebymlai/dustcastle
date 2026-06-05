# dustcastle v1 — build status

Real, kept, test-driven code (TDD). Source of truth stays the ADRs (`docs/adr/`);
this is just the running ledger of what's built.

## Slice 1 — Go path (DONE, green)

The kickoff's red→green spec holds as kept code: **`dustcastle run` in a Go project
→ green `go test ./...` inside a sandcastle podman container, toolchain + deps from
the read-only bind-mounted `/nix/store`, fully offline.**

Modules (each TDD'd; `src/<module>/*.test.ts` are fast unit tests):

| Module | Responsibility | ADR |
|---|---|---|
| `src/detect/` | Owned lockfile→importer router; Go entry + `go.mod` version parse | 0006 |
| `src/nix/go.ts` | `buildGoModule` importer expression generator | 0004 |
| `src/store/` | Rootless nix-portable provisioning: `physPath` translation, vendorHash discovery, store-path parsing, bwrap/proot mode surfacing, `provisionStore` two-pass build | 0008, 0004 |
| `src/sandbox/plan.ts` | The integration seam — `podman()` options: `/nix/store` RO mount, Go env, `network:"none"`, vendor-staging hook | 0002, 0005, 0003 |
| `src/run/` | `prepareRun` (detect→provision→plan) + `run` (hands the Store-mounted provider to `sandcastle.run()`, agentstack `.sandcastle/main.ts` shape) | 0002 |
| `src/cli/main.ts` | Zero-arg `dustcastle run`; surfaces mode + store paths, then hands off | 0002 |

Tests: `npm test` (fast, units only; e2e self-skip) · `DUSTCASTLE_E2E=1 npm run test:e2e`
(real nix-portable build + real podman container; ~14–20s warm).

### Key facts learned (build on these)
- **sandcastle 0.6.6 API** (ground truth): `sandcastle.run({ sandbox: podman(opts), agent,
  hooks, promptFile, … })` and `createSandbox({...}).run()/.close()`. `podman(opts)` takes
  `{ imageName, mounts:[{hostPath,sandboxPath,readonly}], env, network:string|string[],
  selinuxLabel, userns, … }`. The `mounts` array **is** the whole integration seam (ADR 0002).
- The provider's low-level `create()` exists at **runtime** but is **not in the public
  `.d.ts`**. Production uses `sandcastle.run()`; the deterministic e2e gate drives `create()`
  via a typed shim (the spike-proven path) — same `podman()` options either way.
- `sandcastle.run()` injects the **provider-level** `env`; the low-level `create()` path needs
  env passed at `create()` (the e2e delivers dustcastle's planned env there).

## Slice 2 — Node path (DONE, green)

`dustcastle run` works end-to-end for **Node** too: detect npm/pnpm/yarn/bun →
resolve the impurity policy → realize nodejs + `node_modules` into the rootless
Store (offline `npm ci --ignore-scripts` against a hash-pinned npm cache) → plan
the podman provider with `/nix/store` RO and the derived egress → `node --test`
passes **offline** inside the container. Proven by the new unit tests + a gated
Node e2e (real nix-portable build + real podman container, ~13s warm).

New/changed modules (each TDD'd):

| Module | Responsibility | ADR |
|---|---|---|
| `src/detect/` | JS lockfile→importer rows (pnpm/yarn/bun/npm), `packageManager` > lockfile precedence, `.nvmrc`/`.node-version` parse; `Ecosystem` widened to `"go" \| "node"`; per-directory (polyglot) accumulation | 0006 |
| `src/nix/node.ts` | `generateNodeBuild` — `buildNpmPackage` importer: hash-pinned `fetchNpmDeps` + offline `npm ci --ignore-scripts`, publishing `node_modules` as the deps Store path | 0004 |
| `src/impurity/` | The `allow`/`ask`/`deny` state machine (pure), env sourcing (`DUSTCASTLE_IMPURE`), the visible marker, and `npmLockNeedsImpurity` (reads `hasInstallScript` from the lockfile) | 0004, 0005 |
| `src/sandbox/egress.ts` | `deriveEgress` — pure → closed; impure → allowlist (registry + git host, never unrestricted); `parseGitRemoteHost` | 0005 |
| `src/sandbox/plan.ts` | Generalized: per-ecosystem env + staging, and egress decision → podman `network` (pure `"none"`; impure → scoped `dustcastle-egress` net); `egress` surfaced on the plan | 0002, 0005 |
| `src/store/index.ts` | Dispatch Go vs Node; `provisionNode` (pure deps build, or toolchain-only when impure) | 0004, 0008 |
| `src/run/` | `prepareRun` threads the impurity decision (writes the marker, picks egress, sets `impure`) and surfaces it; `src/run/impurity.ts` is the lockfile↔policy↔marker glue | 0004, 0005 |

### The slice-2 hard features (ADR 0004 + 0005), and the open question — settled

- **Impurity policy.** `impure = allow|ask|deny`, sourced from `DUSTCASTLE_IMPURE`
  (config-less, ADR 0005), default `allow`. Pure builds never trip it. `allow` →
  build impurely + write `.dustcastle/impure.json` (a tracked marker = async
  consent). `ask` → prompt once per lockfile hash, **headless falls back**
  decisively (default deny, `DUSTCASTLE_IMPURE_HEADLESS=allow` to flip) so an
  unattended agent never stalls. `deny` → actionable exit. The state machine is
  pure and unit-tested hard.
- **Derived egress.** `network:"none"` is no longer hard-coded: pure → closed;
  impure `allow` → an allowlist derived from detection (the manager's registry +
  the repo's git remote host), never unrestricted. Surfaced on the plan (never
  silent). Mapping note: sandcastle's `network` selects a *named podman network*,
  so the allowlist maps onto a `dustcastle-egress` network whose firewall is the
  host-side enforcement seam (the allowlist itself is fully derived + surfaced).
  **Slice 3 builds that enforcement** (a filtering proxy the build is confined to)
  and proves it live.
- **The open question (kickoff point 5) — settled by `--ignore-scripts` + the
  container gate.** nix-portable enforces no no-network build sandbox, so we do
  **not** rely on it: (a) "impurity needed" is read from the **lockfile**
  (`hasInstallScript`), not from a build that failed offline; (b) the pure
  provision build runs `npm ci --ignore-scripts`, so **no untrusted lifecycle
  code ever runs during provisioning**; (c) untrusted `postinstall` runs only
  later, inside the **container**, under the scoped egress (closed for pure
  projects). The Node e2e proves it: closed container egress (`OFFLINE_OK`) with
  a green `node --test`. The runtime container's egress fully covers the
  build-sandbox weakness, exactly as ADR 0005 claims.

### Deferred from slice 2 (correctly scoped)

- ~~**Live impure-`allow` e2e (a real `postinstall` over scoped egress).**~~
  **DONE — slice 3** (see below). The egress allowlist is now *enforced* and
  *proven live*: an off-allowlist host is blocked while the registry is reachable,
  with a real `npm ci` + untrusted `postinstall` running under the scoped net.
- ~~**Interactive `ask` prompting in the CLI.**~~ **DONE — post-slice-3** (see
  Slice 4 below). The y/n TTY prompt is wired in `src/cli/main.ts`; the pure
  decision (`pendingImpurityAsk` + `parseYesNo`) is unit-tested and a "yes"
  records the consent marker.
- ~~**pnpm/yarn/bun importers.**~~ **pnpm + yarn DONE — Slice 2b** (see below);
  **bun gated** (no canonical nixpkgs importer). Detection already routed all
  three; 2b built the pnpm + yarn importer bodies + provision dispatch and turned
  the generic "unsupported importer" into an explicit, honest bun gate.
- ~~**Committed fixtures.**~~ **DONE — post-slice-3** (see Slice 4 below). All
  samples now live under `test/fixtures/` (`go-sample`, `node-sample`,
  `node-impure-sample`); `ensureNixPortable()` owns the binary; the spike is deleted.

## Slice 3 — Egress allowlist enforcement (DONE, proven live)

Slice 2 *derived and surfaced* the impure-`allow` egress allowlist but mapped it
to a `dustcastle-egress` network **whose firewall did not exist** — ADR 0005's
one claimed-but-unproven guarantee. Slice 3 builds the enforcement and **proves
it live**: an impure `allow` build's untrusted `postinstall` can reach **only**
the derived allowlist (the registry + git host) and nothing else.

The enforcement splits into a portable **filtering proxy** (the security brain,
identical everywhere) and a **confinement** layer that makes that proxy the
build's only way out — with two backends, one proxy:

| Module | Responsibility | ADR |
|---|---|---|
| `src/sandbox/proxy.ts` | `startEgressProxy` — a CONNECT/HTTP forward proxy that tunnels only the allowlisted hosts (`isHostAllowed`: exact, never wildcard) and refuses the rest with 403. No TLS interception. The portable enforcement brain; runs the same in production and the e2e | 0005 |
| `src/sandbox/proxy-main.ts` | Env-driven runnable entrypoint for the proxy (the production proxy *container* and the e2e's host-side process) | 0005 |
| `src/sandbox/confine.ts` | Confinement facade. It derives the standing allowlist, exposes the Sandbox posture (`network` + proxy env), and owns production enforcement (proxy image, external-resolver resolv.conf, `--internal` network, dual-homed proxy container). **Fallback:** `confineRouteScript` — the pasta route-strip for privilege-stripped hosts | 0005 |
| `src/sandbox/plan.ts` | On the allowlist path, routes the container's tooling through the proxy (`HTTP(S)_PROXY` + npm proxy vars) from the supplied confinement posture | 0002, 0005 |
| `src/run/index.ts` | Threads `proxyAddress` through `prepareRun` (production defaults to the proxy container; the e2e overrides with its host proxy) | 0005 |
| `test/fixtures/node-impure-sample/` | Impure fixture: a real registry dep (`is-number`) + a local dep with a `postinstall`, so the lockfile reports `hasInstallScript` and the build resolves impure | 0004 |
| `test/e2e/egress.test.ts` | The live gate (below) | 0004, 0005 |

### Two confinement backends, one proxy (the OS-agnostic story)

- **Production confinement is podman-native and host-OS-agnostic.** A `--internal`
  podman network has no route off-host; a dual-homed proxy container sits on both
  it and an external net, so the sandbox reaches *only* the proxy. Expressed
  entirely in `podman` terms, so it runs the same on Linux/macOS/Windows podman.
  **Now proven live** (see [ADR 0011](adr/0011-production-egress-proxy-container.md)):
  once rootless bridging was restored (a kernel reboot), the first live run of this
  backend exposed three gaps — the proxy image never carried the proxy code, the
  container bound loopback (unreachable cross-container) and resolved through the
  internal net's aardvark (NXDOMAIN-poisoned under musl), and `ensureEgress` logged
  success over a *crashed* proxy. With those fixed (`ensureProxyImage` ships the
  code, `DUSTCASTLE_EGRESS_HOST=0.0.0.0`, an external-resolver resolv.conf bind-mount,
  and a liveness check), the podman-native backend enforces the allowlist live:
  allowlisted hosts `CONNECT 200`, off-allowlist `403`, and an internal-net client
  has no route off-host. (On hosts where rootless bridging is unavailable, the
  fallback below remains the path.)
- **The live proof uses the privilege-stripped fallback.** Where a bridge can't be
  made, the sandbox is confined by `confineRouteScript`: `--cap-add NET_ADMIN` +
  pasta `--map-host-loopback` + add a single host route to the proxy, then **drop
  the default route**. The proxy becomes the container's only reachable address.
  Same proxy, same guarantee, provable on this machine.

### What the gated e2e proves live (`DUSTCASTLE_E2E=1`)

dustcastle's real outputs drive it (`prepareRun` impure-`allow` → derived
allowlist, `dustcastle-egress` network, proxy env, `npm ci`); the **real**
`startEgressProxy` enforces exactly `plan.egress.hosts`; only the confinement is
the fallback backend. Asserted, live, in a container:

- **(a)** a direct (non-proxied) connection to a public IP is **blocked at the
  network layer** — a malicious dep can't bypass the proxy with a raw socket;
- **(b)** the proxy **refuses** an off-allowlist `CONNECT` (`example.com` → 403);
- **(c)** it **allows** `registry.npmjs.org` (→ 200);
- **(d)** a real `npm ci` installs `is-number` from the registry **through the
  proxy** and runs the untrusted `postinstall`, whose own exfil attempt to an
  off-allowlist host is **blocked**;
- **(e)** `node --test` passes.

### Deferred from slice 3 (correctly scoped)

- **Live production-backend e2e (the `--internal` net + proxy container).** Needs
  a podman host with bridge/root; unprovable here, so its spec is unit-tested and
  the live confinement is the pasta fallback. The proxy (the security-critical
  part) *is* proven live.
- ~~**Wiring the production confinement into `run()`**~~ **DONE — post-slice-3**
  (see Slice 4 below). `ensureEgress` (`src/sandbox/egress-runtime.ts`) runs the
  network + proxy generators around `sandcastle.run`. The live run on a capable
  host is still gated (this host can't make a bridge); the command sequence is
  unit-tested.

## Slice 4 — post-slice-3 increments (DONE, green)

Three handoff items, each TDD'd and green (102 unit · 4 gated e2e):

| Item | What shipped | Modules |
|---|---|---|
| **(2a)** Interactive `ask` prompt | The y/n TTY prompt for impure `ask` mode, wired in the CLI. Pure decision (`pendingImpurityAsk` resolves as if a human were present; `parseYesNo` parses the answer) is unit-tested; a "yes" writes the consent marker so `prepareRun` then builds impurely without re-asking. Headless runs skip it entirely (the decisive fallback stands). | `src/run/impurity.ts`, `src/cli/main.ts` |
| **(1-tail)** Production egress backend wired into `run()` | `ensureEgress` brings up the `--internal` egress network (idempotent — tolerates already-exists) + the dual-homed proxy container before `sandcastle.run()`, and tears them down after (guaranteed via `finally`); a failed proxy start rolls back a network it created. No-op on the closed/pure path. Driven through an injected podman runner so the command sequence is unit-tested on this bridge-less host; the live run stays gated for a capable host. | `src/sandbox/egress-runtime.ts`, `src/run/index.ts` |
| **(4)** Spike cleanup (finished) | Go sample committed to `test/fixtures/go-sample`; `ensureNixPortable()` owns the `nix-portable` binary (seeded at `~/.dustcastle/bin/`); `fixture.ts` repointed at the committed paths and the e2e drop the binary injection (default to the owned copy). The Go e2e (`store` + `run`) proven green from the new paths **before** the throwaway `spike-go-store/` was deleted. | `test/e2e/fixture.ts`, the four e2e gates |

## Slice 5 — `dustcastle model` + global pi config for `sandcastle.run()` (DONE, green)

Item (3c)'s **wiring half**. dustcastle drives the **pi** coding agent only
(mirroring agentstack), and the agent model is a **single global choice every
project / every instance shares** — there is **no project-local config** (the why:
[ADR 0009](adr/0009-no-project-local-config.md)). The model lives in
`~/.dustcastle/config.json`; a new `dustcastle model` command picks it (same picker
as agentstack), and `dustcastle run` reads it anywhere. This replaces the v1
`DUSTCASTLE_MODEL` / `DUSTCASTLE_PROMPT` env stopgap.

**Auth = a mounted login, not an API key.** The user authenticates once on the
host (`pi` → `/login`, stored in `~/.pi/agent`); that login dir is **mounted into
every sandbox** (`~/.pi/agent` → `~/.pi/agent`, read-write), so the agent
authenticates in-container with **no per-provider API key**. The model is pi's own
`provider/model` selector (e.g. `"deepseek/deepseek-v4-pro"`, from
`pi --list-models`). Exactly agentstack's mechanism — minus its host pkg-cache
mount, which the Nix Store replaces (the point of §3c).

**The picker** mirrors agentstack: `pi --list-models` (parsed from pi's **stderr**)
→ pick provider (when >1) → pick model → write the global config. It runs on the
**first** `dustcastle run` with no model yet (the install-time pick) and on demand
via `dustcastle model` (re-pick).

| Module | Responsibility | ADR |
|---|---|---|
| `src/config/global.ts` | The global config (`~/.dustcastle/config.json`): `loadModelSelection` / `writeModel` (preserves other keys), `buildPiAgent`, `agentAuthMounts` (the `~/.pi/agent` mount), and `loadHandoff` — model + optional task (`prompt`/`promptFile`, also global) → `SandcastleHandoff`, or `undefined` when there's nothing to launch. Pure + total. | 0002, 0009 |
| `src/cli/pi-models.ts` | `parsePiModels` (pure: skip header, `provider/model` values) + `listPiModels` (runs `pi --list-models`, captures **stderr**). | 0002 |
| `src/cli/select.ts` | `singleSelect` arrow-key TUI, ported from agentstack's `tui.mjs`. | 0002 |
| `src/cli/model.ts` | `chooseModel` (provider→model), `runModelCommand` (`dustcastle model`, TTY-guarded), `ensureModel` (first-run pick; headless no-model fails fast). | 0002, 0017 |
| `src/run/index.ts` | `run()` merges `agentAuthMounts()` into the Sandbox plan's `mounts` before `sandcastle.run()`. | 0002 |
| `src/cli/main.ts` | New `dustcastle model` command; `run` calls `ensureModel()` (first-run picker/headless fail-fast) then launches from the global `loadHandoff()`, surfacing `pi @ <model>`. | 0002, 0017 |

Config + parser + auth mount are exhaustively unit-tested (18 tests, pure — no pi,
no podman); `listPiModels` verified live against real pi. The **live agent run**
needs (a) a host `pi login` and (b) a pi-equipped sandbox image, so it stays
gated/manual (see Deferred) — but the open wiring question is **settled: a global
pi model (`dustcastle model`), the `~/.pi/agent` login mount, and an optional
global task prompt.**

**`~/.dustcastle/config.json` shape** (`dustcastle model` writes `model`; the rest is optional):

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "thinking": "high",
  "prompt": "do the task",
  "maxIterations": 100,
  "hooks": { "onSandboxReady": ["npm install"] }
}
```

A `promptFile` (absolute, or relative to `~/.dustcastle/`) may replace `prompt`.
With a model but no task prompt, `dustcastle run` provisions and reports ready.

## Slice 2b — pnpm + yarn importer bodies (DONE, green; bun gated)

Detection already routed pnpm/yarn/bun (slice 2), but `provisionStore` built only
the npm importer and threw "unsupported importer" for the rest — a half-built
surface. Slice 2b finishes the **pnpm** and **yarn** paths and replaces the
generic throw with an explicit **bun gate** (no canonical nixpkgs importer exists,
so building it wrong is worse than gating it honestly). The egress/proxy plumbing
was already ecosystem-agnostic (registry hosts for all three are in
`REGISTRY_HOSTS`), so impure pnpm/yarn reuse slice 3's enforcement.

Proven by new unit tests (130 unit · 6 gated e2e) + a gated pnpm/yarn e2e
(`test/e2e/pm-run.test.ts`, the npm-gate analogue; self-skips without a warm store).

| Module | Responsibility | ADR |
|---|---|---|
| `src/nix/pnpm.ts` | `generatePnpmBuild` — `fetchPnpmDeps` (hash-pinned, `fetcherVersion = 3`) + offline `pnpm install --ignore-scripts` (`pnpmConfigHook`), publishing `node_modules` as the deps Store path. Same `{ toolchain:"nodejs", deps, app }` contract as the npm importer | 0004 |
| `src/nix/yarn.ts` | `generateYarnBuild` — Yarn v1: `fetchYarnDeps` (hash-pinned by `yarn.lock`) + offline `yarnConfigHook` install. Purity is structural: only the config hook runs (no `yarnBuildHook`), so no package lifecycle scripts execute during provisioning | 0004 |
| `src/store/index.ts` | `provisionNode` generalized to **`provisionJs`** (shared by npm/pnpm/yarn — the only per-manager difference is the generated expression); dispatch routes `fetchPnpmDeps`/`fetchYarnDeps` and **gates `fetchBunDeps`** with an actionable error. Hash discovery (placeholder probe → `parseVendorHashMismatch`) is FOD-generic, so it works for all three importers unchanged | 0004, 0008 |
| `src/sandbox/plan.ts` | Impure container install made manager-aware (`IMPURE_INSTALL`): `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` (frozen so an impure build still can't drift from the lockfile). The pure path stays manager-agnostic — every JS importer publishes the same `node_modules` layout | 0004, 0005 |
| `test/fixtures/{pnpm,yarn}-sample/` | Committed samples: real `pnpm-lock.yaml` / `yarn.lock` (one real dep, `is-number`; zero deps, no install script → pure path) + a built-in `node --test`, mirroring `node-sample` | 0006 |
| `test/e2e/pm-run.test.ts` | Gated pnpm + yarn pure-path e2e (the npm-gate analogue). Supplies **no** known hash → exercises live two-pass discovery; asserts the toolchain resolves from the RO Store, the container is offline, and `node --test` passes | 0002–0008 |

### bun — gated, not faked (the open research question, settled honestly)

nixpkgs has **no canonical bun deps importer** (no `fetchBunDeps` analogue to
`fetchPnpmDeps`/`fetchYarnDeps`; `importNpmLock`/`buildNpmPackage` cover npm, the
yarn/pnpm hooks cover those, and the "outside nixpkgs" tools like `npmlock2nix`
can't be used inside a build because they need Import-From-Derivation). So there's
no hermetic, hash-pinned way to assemble `node_modules` from `bun.lock` yet.
Detection still routes bun; `provisionStore` gates it with a clear, actionable
error rather than shipping a wrong build. The bun importer is the tracked
follow-up. (Confirmed via context7 against current nixpkgs docs.)

### Deferred from slice 2b (correctly scoped)

- **bun importer** — gated above; awaits a canonical nixpkgs path (or a vetted
  out-of-tree importer that doesn't need IFD).
- ~~**Impurity detection for pnpm/yarn lockfiles.**~~ **pnpm DONE — Slice 2c**
  (see below); **yarn settled (no lockfile signal exists)**. `resolveImpurity` now
  dispatches per manager: npm `hasInstallScript`, pnpm `requiresBuild: true`. yarn.lock
  carries no install-script metadata at all (it lives in `package.json#dependenciesMeta`
  / `.yarnrc`), so yarn stays pure by design — the safe default, not a gap.
- **Live pnpm/yarn e2e on a warm store.** `pm-run.test.ts` is gated and, unlike
  the npm gate, supplies no known hash (it discovers live) — so its first run on a
  capable host pays the discovery build. No warm pnpm/yarn store exists on this
  rootless host, so the live proof is for a capable host (same posture as the
  other gated e2e).

## Slice 2c — pnpm impurity detection; yarn settled (ADR 0004)

Slice 2b built the *plumbing* for an impure pnpm/yarn run (toolchain-only provision,
frozen-lockfile install, derived egress) but `resolveImpurity` read the install-script
signal from npm's `package-lock.json` only, so pnpm/yarn projects always resolved pure.
Slice 2c finishes the per-manager **signal** that triggers it — and settles yarn honestly.

| Module | Responsibility | ADR |
|---|---|---|
| `src/impurity/index.ts` | `pnpmLockNeedsImpurity` — the pnpm analogue of `npmLockNeedsImpurity`. pnpm-lock.yaml has no `hasInstallScript`; its equivalent is `requiresBuild: true` on a package's metadata entry (a dep with install/postinstall scripts or a native build). YAML, so it's scanned as text (an owned line parser — no dep, ADR 0001 — mirroring `detect/workspace.ts`); the indentation anchor keeps `requiresBuild` a real nested key. Conservative: non-string / no flag → pure | 0004 |
| `src/run/impurity.ts` | `resolveImpurity` now **dispatches per manager** (`lockfileName` + `lockNeedsImpurity`): npm→`package-lock.json` (`hasInstallScript`), pnpm→`pnpm-lock.yaml` (`requiresBuild`); the marker's `lockfileHash` keys off the manager's own lockfile. Flows through `pendingImpurityAsk` (the interactive `ask` gate) unchanged | 0004 |

### yarn — settled honestly (no lockfile signal exists)

yarn.lock (v1) records only `version`/`resolved`/`integrity`/`dependencies` — there is
**no `hasInstallScript`/`requiresBuild` equivalent**. yarn's build policy lives in
`package.json#dependenciesMeta.built` and `.yarnrc` (`enableScripts`), **not** the
lockfile (confirmed via context7 against current yarn docs). So a yarn project always
resolves **pure** — the safe default, not a gap: the pure `yarnConfigHook` provision
never runs untrusted scripts, and faking a signal the lockfile can't carry would be
worse than honest (the bun-gate honesty pattern). A unit test pins this contract so a
future change can't silently flip it. bun is gated at provision; nothing to detect here.

Pure + unit-tested (8 new unit tests, **167 unit · 9 gated e2e**, all green). No e2e
needed — the impure run plumbing it triggers was already proven live by slice 3's gate.

## Slice 3a — Detection router breadth (ADR 0006)

### 3a-i — Loose-manifest pin-then-pure (DONE, green; gated e2e)

ADR 0006c's **preferred path over impurity**: a resolvable-but-unpinned manifest (a
`package.json` with **no lockfile**) is resolved **once** into a generated, committed
lockfile (a one-time online resolve, a visible artifact), then every build runs
**pure/offline** against it. Strictly better than `allow` — the project gains a real
lock it lacked and nothing hits the network at install time afterward.

| Module | Responsibility | ADR |
|---|---|---|
| `src/detect/index.ts` | `Detection.loose` — a JS manifest with no lockfile is flagged loose (resolvable-but-unpinned); a lockfile clears it | 0006c |
| `src/run/pin.ts` | `lockOnlyResolve(pm)` — the pure, manager-specific lock-only invocation (**npm** `install --package-lock-only`, **pnpm** `install --lockfile-only`; both update only the lockfile, no `node_modules`/scripts). `pinLooseManifest` runs it in place via an injected runner and surfaces the generated lock | 0006c |
| `src/run/index.ts` | `prepareRun` runs pin-then-pure between detect and impurity: loose → resolve → re-detect (now lock-pinned, pure) → provision; `pinned` surfaced on `PreparedRun` | 0004, 0006c |
| `src/cli/main.ts` | Surfaces the generated lock in the provisioning summary (never silent) | 0006c |
| `test/fixtures/node-loose-sample/` + `test/e2e/pin-run.test.ts` | Loose fixture (is-number, **no** lockfile) + gated e2e: resolve → pure build → offline `node --test`. Supplies **no** known hash → exercises live two-pass discovery (the pm-run posture) | 0006c |

**Scoping (recorded so it isn't silently dropped):**
- **JS-first.** `requirements.txt` (Python) is named by ADR 0006c but needs a **Python
  Ecosystem first** — a bigger lift than 3a. **Out of scope** until explicitly asked.
- **yarn is gated, not faked.** Yarn classic has **no clean lockfile-only resolve**;
  `lockOnlyResolve("yarn")` throws an actionable error (commit a `yarn.lock`, or use
  npm/pnpm) rather than running a full install just to pin — the bun-gate honesty pattern.
  bun (and any unknown manager) gate the same way.

### 3a-ii — Per-workspace monorepo detection (DONE, green; gated e2e)

A workspace root (`pnpm-workspace.yaml`, or `package.json#workspaces` for npm/yarn)
enumerates its members; dustcastle provisions **each** — consistent with the existing
per-directory accumulation (a member is just another directory to `detect()`).

| Module | Responsibility | ADR |
|---|---|---|
| `src/detect/workspace.ts` | `workspaceMembers(root)` — a thin owned glob enumerator (no dep — ADR 0001): reads pnpm-workspace.yaml's `packages:` list or package.json `workspaces` (array **or** the yarn `{packages}` object form), expands exact paths / `dir/*` / `dir/**` with `!` exclusions, keeps only dirs containing a `package.json`. `detectWorkspace(root)` → the fan-out shape `{root, isWorkspace, projects:[{dir, detections}]}` (single root project when not a workspace) | 0006d |
| `src/run/index.ts` | `prepareWorkspace(opts)` — runs the full detect→pin→provision→plan pipeline per member (`PreparedWorkspace`); members with no detected ecosystem are skipped; falls back to the single root project | 0006d |
| `test/e2e/workspace-run.test.ts` (+ `stageWorkspaceProject`) | Gated e2e: a 2-member npm workspace (members reuse the pure node-sample) → both enumerated, each provisioned, `node --test` green offline per member | 0006d |

**Contract:** `detect()` stays per-single-directory; the workspace layer composes it
over enumerated members. CLI multi-member *launch* (which member(s) an agent runs in)
is a separate orchestration choice beyond detection breadth — `prepareWorkspace` delivers
the detect-and-provision-each that ADR 0006d specifies; the CLI still uses `prepareRun`
for the single-project common case.

### 3a-iii — JS `devEngines` toolchain-version source (DONE, green)

`package.json#devEngines.runtime` (the strict, npm-enforced manifest contract) is read
as a Node toolchain-version source. **Precedence (highest first): `devEngines.runtime`
(node) > `.nvmrc` > `.node-version`** — the explicit manifest contract wins. Handles
both the single-object and array forms of `runtime`; falls through when no node entry
is declared. Unit-tested in `src/detect/`.

## Slice 3b — Store GC / lifecycle (ADR 0007) (DONE, green; gated e2e)

The shared rootless `/nix/store` grows unbounded (Nix never GCs by default). 3b keeps
it lean **without collecting paths a live run still needs**, via ADR 0007's three
mechanisms, driven through nix-portable (same spawn shape as `runNixBuild`).

| Module | Responsibility | ADR |
|---|---|---|
| `src/store/gc.ts` | The pure decisions + injected-runner orchestration. **Which paths root:** `rootStorePaths` → the toolchain + deps closure (skips the empty impure deps path, dedups). **Command construction:** `addRootArgs` (`nix-store --add-root <link> --realise <path>`, indirect), `collectGarbageArgs` (`--gc`), `optimiseArgs` (`--optimise`), `gcQueryArgs` (non-destructive `--print-dead`/`--print-live` dry-run), `gcRootLink` (scoped link keyed by lockfile hash + kind, filesystem-safe). **Report parsing:** `parseGcReport` (paths deleted + bytes freed), `parseOptimiseReport` (bytes + files hard-linked) — the surfaced, never-silent report. **Orchestration (injected `NixRunner`, mirrors `PodmanRunner`):** `registerScopedRoots` (one root per closure path, best-effort, `release()` removes the link symlinks), `collectGarbage` (optimise-then-gc, surfaced reports). `nixPortableRunner()` is the real default | 0007, 0008 |
| `src/run/index.ts` | `run()` brackets `sandcastle.run()` with `registerScopedRoots` (keyed by `gcProjectKey` = manager + deps FOD hash) and releases them in the `finally` — per-run, released on completion, so a concurrent collect never deletes a path the live run needs. Best-effort + injectable (`opts.gcRoots`); the default uses real nix-portable | 0007 |
| `test/e2e/gc.test.ts` | Gated, **deliberately non-destructive** live proof: provision a real closure, register scoped roots, assert the toolchain path is reported **live** (would be kept) and **not dead** by `nix-store --gc --print-{live,dead}`, then release. Uses the dry-run so it never deletes warm-store paths the other e2e fixtures rely on | 0007 |

**Scoping (recorded):**
- **No *auto*-GC in v1 yet.** Scoped roots are registered/released around every `run()`
  (safe — additive). ~~ADR 0007's disk-ceiling/recency **policy trigger** is a
  follow-up.~~ **The pure policy + manual `dustcastle gc` shipped — Slice 2d** (below);
  only the *auto-trigger* (threshold value + mechanism + recency persistence) remains a
  gated OPEN DECISION. There is no risk of the warm store being collected.
- ~~**Destructive live `nix-store --gc`** … its real-deletion e2e needs a dedicated
  scratch NP store (a capable-host follow-up).~~ **DONE — Slice 2d**
  (`test/e2e/gc-collect.test.ts`): a real collect against a fresh `NP_LOCATION` scratch
  store, guarded so it never touches the warm `~/.nix-portable`. The warm-store gate
  here stays **non-destructive** by design.

## Slice 2d — GC policy trigger (pure) + manual `dustcastle gc` (ADR 0007)

Slice 3b built the GC *mechanisms* (scoped roots, `collectGarbage`, `optimise`) but
**nothing collected automatically** and there was **no user-facing sweep**. 2d adds
ADR 0007's **policy decision** as pure, parameterized functions and a **manual
`dustcastle gc`** command. The disk-ceiling **threshold value** and the **auto-trigger
mechanism** (when to invoke the policy — post-run hook? a scheduled check?) stay an
**OPEN product decision**, so the auto-trigger is deliberately **not wired**; the pure
policy + manual command are buildable and shipped without it.

| Module | Responsibility | ADR |
|---|---|---|
| `src/store/gc.ts` | The pure policy brain (no baked-in numbers — every threshold is a parameter). `shouldCollectGarbage({storeBytes, ceilingBytes})` — the disk-ceiling trigger ("collect the rest on a disk ceiling"). `recencyTailKeys(records, limit)` — the **bounded recently-used tail** to keep rooted (the `limit` most-recently-used project keys, newest first), so a just-bumped toolchain stays warm. `garbageCollectionPlan({storeBytes, ceilingBytes, records, tailLimit})` → `{sweep, keep}` composes the two: ADR 0007's chosen stance ("keep what active projects root + a bounded recently-used tail; collect the rest on a disk ceiling"). This is the **gated auto-trigger's** pure brain — built + unit-tested, not yet invoked | 0007 |
| `src/cli/gc.ts` | `runGcCommand` — the manual, user-invoked sweep: `nix store optimise` → `nix-store --gc`, surfacing what it freed (never silent). No threshold/tail: the user asked, so it always sweeps; an in-flight `dustcastle run` stays safe because its closure is pinned by live scoped roots until completion. Nix runner injectable for tests | 0007 |
| `src/cli/main.ts` | New `dustcastle gc` command (+ USAGE line) dispatching to `runGcCommand` | 0002, 0007 |
| `test/e2e/gc-collect.test.ts` | Gated **destructive** proof: a real `nix-store --gc` against a **dedicated scratch NP store** (a fresh `NP_LOCATION` under the OS tmpdir, **never** the warm `~/.nix-portable`; a hard guard refuses to sweep unless `NP_LOCATION` is a throwaway dir ≠ `$HOME`). Pins one already-present dead path via the real `registerScopedRoots`, runs a real `collectGarbage`, asserts unrooted paths are **freed** while the scoped-rooted path **survives** (live, not dead). Roots an existing path rather than cold-building a closure, so the proof runs in ~16s (an earlier full-closure variant's ~270s synchronous build blocked the worker event loop and tripped vitest's reporter RPC); `afterAll` does `chmod -R u+w` before removing the read-only nix store. **Ran live, green.** The scratch-store harness the prior handoffs deferred as a capable-host follow-up | 0007 |

Pure + unit-tested (this slice added **5 unit tests** — `shouldCollectGarbage`,
`recencyTailKeys`, `garbageCollectionPlan` ×2, `runGcCommand` — to the 167 baseline, plus
the gated destructive e2e; all green, typecheck + build clean). `NP_LOCATION` scratch-store
isolation was verified non-destructively before writing the destructive gate (a fresh
`NP_LOCATION` builds a self-contained `<dir>/.nix-portable` tree; the warm store is
untouched).

### Direction DECIDED — auto-GC is the main path (design being grilled)

**Decided (product):** **auto-GC is THE main path** — the user must never worry about the
store or "files," ever. The manual `dustcastle gc` shipped above is **demoted to a
debug/convenience** command, *not* the primary route. The pure policy brain
(`garbageCollectionPlan`) is ready to compose.

**Being grilled (the *how*, not the *whether*) — see
`/tmp/dustcastle-v1-autogc-grill-handoff.md`:** the trigger mechanism (post-`run()` hook /
periodic / opportunistic), the disk-ceiling principle + default (absolute vs % of free
disk), the recency-tail bound (count / age / bytes), **recency persistence** (a
`projectKey → lastUsedAt` record `run()` updates — location/format/concurrency), the
eager-vs-cold-rebuild stance (+ optional remote binary cache), and reconciling ADR 0007's
**never-silent** with zero-worry UX (likely quiet-by-default + a one-line summary). Plus
safety: a sweep must never race an in-flight `run()` and a failed GC must never break one.

Once the design lands, the auto path is: measure store size → `garbageCollectionPlan` →
keep the tail + active roots, release the rest → `collectGarbage`. Build it TDD; gate any
real `nix-store --gc` behind `DUSTCASTLE_E2E` against a scratch store.

## Deferred (correctly, per kickoff build order)

- **Live `sandcastle.run()` agent orchestration** — fully **wired**: `src/run/run` + the CLI
  drive `sandcastle.run()` with the **pi** agent at the global model (`dustcastle model`), the host
  `~/.pi/agent` login mounted into the sandbox, and an optional global task prompt (Slice 5 — the
  open wiring question is settled). What remains gated is only the **live agent execution**, which
  needs (a) a host `pi login` and (b) a sandbox image carrying the `pi` binary (agentstack bakes
  `@mariozechner/pi-coding-agent` into its Containerfile; dustcastle's stock `debian:bookworm` does
  not yet). The deterministic gate proves the provisioning seam instead. To run it manually: `pi` →
  `/login`, `dustcastle model`, add a `prompt` to `~/.dustcastle/config.json`, use a pi-equipped
  image, `dustcastle run`.
- **vendorHash discovery** is unit-tested (`parseVendorHashMismatch`) and runs when `vendorHash`
  is omitted, but the e2e supplies the known hash for a fast warm-Store cache hit — the live
  two-pass discovery build isn't in the gated suite.
- ~~Slice 2 — Node~~ **DONE** (see the Slice 2 section above): ADR 0004 impurity policy +
  ADR 0005 derived egress are built, green, and the open question is settled.
- ~~Detection router breadth (0006 — loose-manifest pin-then-pure, the JS `devEngines` field,
  per-workspace monorepo detection), store GC/lifecycle (0007).~~ **DONE — Slices 3a + 3b**
  (see those sections above). Remaining sub-scopes: Python/`requirements.txt` pin-then-pure
  (needs a Python Ecosystem first) and CLI multi-member workspace *launch* — both need a
  product decision before coding. The GC **pure policy + manual `dustcastle gc` + destructive
  scratch-store gate** shipped in **Slice 2d**; only the GC *auto-trigger* (threshold +
  mechanism + recency persistence) remains a gated OPEN DECISION.

## Environment notes
- Works in place (no git worktrees — `/home/laimk` is itself the git repo; dustcastle is an
  untracked subtree). The bg-isolation guard reads the **git-root** settings, so
  `worktree.bgIsolation:none` had to go in `/home/laimk/.claude/settings.json` (a `.bak` of the
  original is beside it) as well as `dustcastle/.claude/settings.json`.
- E2E tests source their samples from `test/fixtures/` and the `nix-portable` binary from
  the dustcastle-owned `~/.dustcastle/bin/nix-portable` (via `ensureNixPortable()`), against
  the warm `~/.nix-portable` store. The throwaway `spike-go-store/` has been **deleted** — v1
  now fully owns its fixtures + runtime (post-slice-3 item (4)).

## Orchestration — parallel-planner-with-review (built; live loop gated)

agentstack's four-phase RALPH loop, ported as a **built-in** dustcastle workflow on the
Store-provisioned podman provider (ADR 0001/0002). `dustcastle run` now drives it (the old
single-agent run path was a stub): **plan** (one pi agent reads ready beads issues → `<plan>`
JSON of unblocked issues + `sandcastle/issue-{id}` branches) → **execute+review** (per issue,
in parallel via `Promise.allSettled`: implementer ≤100 iters then, if it committed, reviewer 1
iter in the *same* per-issue sandbox) → **merge** (one agent merges the branches that committed
and `bd close`s them) → outer loop ×`DEFAULT_MAX_LOOPS` (10) so newly-unblocked issues get picked
up.

Modules (each pure helper TDD'd — 13 new unit tests, all green; 217 total):

| Module | Responsibility |
|---|---|
| `src/agent/prompts/*.md` + `prompts.ts` | The four bundled prompts (beads commands inline) + loader (`orchestrationPromptPath` / `loadOrchestrationPrompt`). `scripts/copy-assets.mjs` copies them into `dist/` at build (tsc emits only .js). |
| `src/run/plan-schema.ts` | zod `planSchema` + `sandcastle.Output.object` `<plan>` definition. |
| `src/run/orchestrate.ts` | Pure helpers: `branchForIssue`, `implementArgs`/`reviewArgs`/`mergeArgs`, `completedFrom` (only fulfilled outcomes with commits>0 advance to merge), `phaseConfig`. Plus the gated live loop `orchestrate()` + `executeIssue()`. |
| `src/run/beads.ts` | Host preflight (`bd` on PATH + `.beads/` exists), injectable. |
| `src/run/index.ts` | Extracted `withProvisionedSandbox` — the egress + scoped-GC-root confinement bracket (ADR 0005/0007), now shared by `run()` and `orchestrate()` so the invariant lives in one place. |

Decisions locked (with the user): **zod** for the plan schema · **beads** as the tracker (baking
`bd` into the sandbox image = gated image work) · **single global model** (`buildPiAgent(loadModelSelection())`, ADR 0009) · `dustcastle run` *is* the orchestrator.

`.beads` handling mirrors agentstack (`bin/sandcastle-setup.mjs`): `.beads/` is git-excluded
(stealth) and carries a Dolt DB, so execute worktrees force-copy it via
`copyToWorktree: [".beads"]`; plan/merge run on the host checkout so `bd close` persists.

Findings / corrections made while porting:
- **Inline `prompt` strings get no processing** in sandcastle (no `{{KEY}}`, no `` !`cmd` ``);
  those only work via `promptFile`. The loop passes absolute `promptFile` paths, not text.
- **`{{TARGET_BRANCH}}` is reserved** (sandcastle auto-injects it; passing it is an error). The
  review prompt was renamed to a custom **`{{BASE_BRANCH}}`** we control deterministically —
  agentstack's "unfilled `{{TARGET_BRANCH}}`" was *not* a bug, just the auto-injected value.

**Gated (DUSTCASTLE_E2E, capable host — not runnable here):** the live `sandcastle.run` /
`createSandbox` calls, the parallel pipeline, real pi agents, the merge. Needs (a) a pi+bd-equipped
sandbox image, (b) host `pi login`, (c) a repo with beads issues. **To verify on a capable host:**
that top-level `sandcastle.run` (plan/merge) bind-mounts cwd so the real `.beads` is present, and
that `promptFile` `` !`cmd` `` expansion runs in-sandbox (where bd/git live).

## Slice 2e — Auto-GC: the Store maintains itself (ADR 0007; bead `laimk-7yx`)

Slice 2d shipped the GC *mechanisms* + pure brain + manual `dustcastle gc`, but **nothing
collected automatically** — the auto-trigger was a gated OPEN DECISION. 2e closes it: auto-GC is
now **the main path**. After each run, a **detached one-shot** sweeps the Store in the background
when it is over a disk-derived **hybrid ceiling** — `optimise`-first, then a byte-budget-LRU
collect of the non-warm closures — entirely off the hot path. The operator never runs a command,
never sees a prompt, never sets a threshold; the only trace is a one-line "freed X" surfaced at
the *next* run. Manual `dustcastle gc` stays as the debug/force affordance (unchanged).

Built TDD — **32 new unit tests** across four modules (pure decisions injected; real
`nix store optimise`/`nix-store --gc` gated). Total **217 unit · 11 gated e2e**; typecheck +
build clean. The new destructive e2e **ran live green** (real optimise→gc on a scratch store;
both a scoped and a recency root survive).

| Module | Responsibility | ADR |
|---|---|---|
| `src/store/ceiling.ts` (new) | The disk-derived hybrid watermark. Pure `overCeiling({storeBytes, freeBytes, totalBytes}) → {over, reason}` — fires on a size **cap** (high watermark) OR a free-space **floor**, whichever bites first; the recency byte budget (`recencyBudgetBytes`) is the strictly-lower **low watermark** (hysteresis, so a sweep can't thrash at the boundary). Every threshold derives from the disk total (machine-adaptive, zero-config — no baked-in number). The size accounting it consumes is injected: `measureStoreBytes` (nix `path-info --all` nar-size sum, **not** a `du` walk), `diskSpace` (statfs), `closureSizeBytes` (`path-info -S`). | 0007 |
| `src/store/recency.ts` (new) | The derived-STATE index at `~/.dustcastle/recency.json` (kept out of `config.json` — ADR 0009). `loadRecency` (degrade-to-empty on missing/corrupt — never crashes a run), `upsertRecency` (atomic temp+rename, last-writer-wins per key, version envelope). | 0007, 0009 |
| `src/store/autogc.ts` (new) | The detached one-shot's orchestration: `autoGc({run, measure, disk, dir, recencyRootsDir, now, onLine}) → AutoGcReport \| "skipped"`. Lock (`gc.lock`, exclusive) → measure → load recency → `garbageCollectionPlan` → **prune cold recency roots** → `optimise` → re-check (fresh disk; optimise frees space but not logical size) → **conditional** `--gc` (skipped if optimise alone cleared the ceiling) → append `gc.log`. Best-effort to the bone: a throwing runner yields a surfaced WARNING and a no-op report, never a throw. `readLastSweepLine` is the next-run surfacer. | 0007, 0008 |
| `src/store/gc.ts` (modified) | `RecencyRecord` gains `closureBytes`; `recencyTailKeys(records, budgetBytes)` flips count→**byte-budget LRU** (keeps the newest closures that fit; a single oversize closure is dropped); `garbageCollectionPlan` takes the hybrid ceiling (`overCeiling`) + byte budget. New `registerRecencyRoot` (persistent, **not** released with the run) + `pruneRecencyRoots` (drop roots outside the warm budget) + `defaultRecencyRootsDir` (a sibling of the scoped `gcroots`). `shouldCollectGarbage` removed (subsumed by `overCeiling`). | 0007 |
| `src/cli/autogc.ts` (new) | The hidden `dustcastle __autogc` child entry (`runAutoGcCommand`, real wiring, always returns 0 / never throws) + the detached-spawn helper `spawnAutoGc` (`node <cli> __autogc`, `detached + unref`, best-effort). | 0007, 0008 |
| `src/run/index.ts` (modified) | In the shared `withProvisionedSandbox` bracket: after scoped roots, `upsertRecency` + `registerRecencyRoot` for this project (warm across runs); in the `finally`, after `roots.release()`, fire the detached `__autogc` one-shot. Both best-effort + injectable (`ProvisionOptions.autoGc`: disable / redirect dirs / inject the runner or spawn). Wired once per run/orchestrate call (not per per-issue sandbox). | 0007 |
| `src/cli/main.ts` (modified) | Hidden `__autogc` command dispatch (out of USAGE); surfaces the last sweep's `🧹 … freed X` line at run startup (read-tail of `gc.log`, degrades silently when absent). | 0007 |
| `test/e2e/gc-collect.test.ts` (extended) | A second destructive gate: drives the real `autoGc` (injected size/disk force the trigger; real `optimise`→`--gc`) on the scratch NP store with BOTH a scoped and a recency root present, asserting both rooted closures survive (live, not dead) while unrooted paths are freed. Ran live green. | 0007 |

**Chosen values (all disk-fraction-derived in `ceiling.ts`, no absolutes — kept LEAN):** size cap
= 10 % of disk (high watermark), warm byte budget = 7 % (low watermark — the hysteresis gap),
min-free floor = 10 %. On a 500 GB disk that's a sweep at ~50 GB collecting down to ~35 GB warm
(the classic "50 GB store" as the *ceiling*, not the steady state); on a 4 TB box the same
fractions grow generously (ADR 0007 story 8), and the free-space floor is the independent
disk-full backstop regardless of Store size (story 9). Eviction is byte-budget LRU behind the one
pure `recencyTailKeys`, swappable for frequency-aware (S3-FIFO) later without touching the
trigger/persistence/roots (ADR 0007).

**Deferred (correctly scoped):**
- **`min-free`/`max-free` mid-provision backstop** — the optional belt-and-suspenders in the
  rootless nix-portable config (ADR 0007). Lower priority than the main async trigger; verify it
  works under nix-portable empirically before relying on it (context7 has no nix-portable docs).
- **Remote binary cache** (eager-GC enabler) and **frequency-aware eviction** — named in ADR 0007,
  out of scope for v1.
- **Live production spawn under the orchestration loop** — the detached child fires from the
  shared bracket, so `orchestrate()` gets auto-GC for free; its live proof rides the same gated
  capable-host path as the orchestration loop itself.
