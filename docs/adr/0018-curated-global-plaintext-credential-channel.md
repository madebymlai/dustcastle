# Credentials: a curated, global, plaintext injection channel for build secrets

A build can need a real secret that pure default-deny ([ADR 0005](0005-sandbox-secrets-and-egress.md))
withholds. `aegis-rd` is a `uv` project whose `vectorbtpro` dependency is a **private, paid**
git repo (`github.com/polakowo/vectorbt.pro.git`, pinned in `uv.lock`), so the in-Sandbox `pip`
git-clone needs a GitHub token to install at all. ADR 0005 forwards **no** host environment into a
Sandbox, so today there is no way to get that token in and the build cannot run. This ADR adds the
one explicit channel that lets it — and in doing so **supersedes ADR 0005 decision 1**.

## Decisions

1. **A closed, curated catalog of Credentials.** dustcastle owns a vetted set of recognised host
   secrets — the Ecosystem Registry's sibling ([ADR 0001](0001-nix-store-as-the-toolchain-mechanism.md):
   internal curation, **not** a user-facing plugin system). v1 ships two descriptors: **GitHub**
   (`GITHUB_TOKEN` → `github.com`) and **GitLab** (`GITLAB_TOKEN` → `gitlab.com`). Adding a third
   (Bitbucket, a registry token) is a one-descriptor **code** change, never user configuration. The
   operator fills a **value**; they never invent a **key**.

2. **The value is stored plaintext in the global config.** `dustcastle config` writes each
   Credential's value into `~/.dustcastle/config.json`, beside the model selection — a per-user,
   configure-once setting ([ADR 0009](0009-no-project-local-config.md)). **This reverses ADR 0005
   decision 1's "never a dustcastle config file."** It is an eyes-open trade-off: the alternatives
   (read-only from host env; an external secret-store *reference* such as `gh auth token`) were
   considered and rejected for the operator's need to configure once and run unattended without a
   host secret tool.

3. **Injected into every Sandbox.** A configured Credential is forwarded into **every** Sandbox
   dustcastle stands up, not scoped to the project that needs it. **This reverses ADR 0005
   decision 1's "scoped to what a build/test needs."** It follows the precedent ADR 0009 already
   set for the pi login (one global credential mounted into every Sandbox), accepting the wider
   blast radius (see Consequences) in exchange for zero per-project ceremony.

4. **The descriptor owns the git wiring.** A bare token does nothing — git does not read
   `GITHUB_TOKEN`. Each descriptor therefore carries its git credential-helper wiring as **data**,
   injected as **ambient `GIT_CONFIG_*`** env (host-scoped `credential.https://<host>.helper`, with
   the forge's username convention: `x-access-token` for GitHub, `oauth2` for GitLab). Ambient
   `GIT_CONFIG_*` needs no `git config` setup step, so it sidesteps the hook-ordering constraint
   (dustcastle prepends its install hook ahead of caller hooks); and a credential **helper** — not
   `url.insteadOf` — keeps the token out of git's URLs → out of error messages → out of the persisted
   install logs ([ADR 0014](0014-structured-logging-owned-port-afk-flight-recorder.md)). (Scoped
   egress was removed in [ADR 0020](0020-drop-scoped-egress-toolchain-manager-not-containment-sandbox.md),
   so a Credential needs no egress-host clause — it is pure token injection + git wiring.)

5. **An agent-env collision fails fast and legibly, not mid-run.** sandcastle's `mergeProviderEnv`
   throws if any key overlaps between the agent provider env (pi) and the sandbox provider env — and
   dustcastle puts the Credential keys (the token var + `GIT_CONFIG_*`) in the sandbox provider env.
   A descriptor whose key collides with pi's env would therefore abort the run with sandcastle's
   cryptic late error, *after* provisioning. dustcastle instead validates disjointness itself —
   before any Sandbox stands up — and throws an actionable error naming the offending key, mirroring
   how `modelProviderHosts` (`src/config/global.ts`) fails at plan time rather than as a mid-run
   "Connection error." A curation test asserts the **shipped** catalog stays disjoint from pi's
   provider env, so a bad new descriptor fails in CI, not in production. The Credential keys are the
   literal names git/pip read (`GITHUB_TOKEN`, `GIT_CONFIG_*`), so they cannot be namespaced away —
   detection is the only defence.

## Why

The motivating build is simply impossible under pure default-deny: a paid private dependency cannot
install without a credential, and dustcastle's whole value for `aegis-rd` is standing up that build.
ADR 0005 anticipated exactly this — *"secrets are injected only when explicitly declared"* — and
named the environment / a secret-store reference as the channel. The operator has chosen the most
**ergonomic** point in that space (a value in the global config, forwarded everywhere) over the most
**contained** one. Making the channel **curated and self-wiring** is what keeps that choice from
also being a footgun: because dustcastle only ever injects keys it shipped, the name set is small
and known — it cannot scoop up `HOME`/`PATH`/unrelated secrets the way a `process.env` multi-select
would, and it is curated to never collide with the agent provider env (sandcastle's
`mergeProviderEnv` throws on an agent/sandbox key overlap).

## Considered Options

- **Names only, value read from host `process.env`.** ADR-0005-compatible ("the environment");
  rejected by the operator — an unattended run has no populated shell env, so it fails headless.
- **An external secret-store *reference*** (`gh auth token`, `op read …`). The second channel
  ADR 0005 blesses; no secret at rest; headless-safe. Rejected by the operator as assuming host
  secret tooling they don't want to require.
- **Plaintext value in the config file (chosen).** Simplest; reverses ADR 0005 decision 1; the
  secret is unencrypted on disk (config.json is `0644` — readable by other local users) and goes
  stale on rotation.
- **Per-project / derived-by-host scope.** Honours ADR 0005's "scoped to need"; rejected for
  per-project ceremony, and "derived by host" barely narrows anything because `github.com` is in
  nearly every project's allowlist already.
- **Generic env passthrough (a `process.env` multi-select).** The original sketch; rejected — it
  cannot know that `GITHUB_TOKEN` should become a git credential helper, reintroduces the footgun,
  and risks the `mergeProviderEnv` collision.

## Consequences

- **A forwarded token is readable by untrusted third-party code in every Sandbox.** A
  `postinstall` / `build.rs` / proc-macro can read `GITHUB_TOKEN` and — with scoped egress removed
  ([ADR 0020](0020-drop-scoped-egress-toolchain-manager-not-containment-sandbox.md)) — exfiltrate it
  to **any** host. Running dustcastle on an *unfamiliar* repo exposes the configured Credentials to
  that repo's dependency code. This is accepted under the trusted-deps / own-repos model (ADR 0020);
  the credential-helper wiring narrows only the *log* leak, not the *in-Sandbox-code* read.
- **Credentials are unencrypted at rest** in `~/.dustcastle/config.json`; backups and dotfile-sync
  capture them, and they must be re-entered on rotation.
- **A descriptor/agent-env collision is caught at plan time** (decision 5) with an actionable error
  naming the key, instead of sandcastle's late, cryptic `mergeProviderEnv` throw; the shipped
  catalog's disjointness from pi's provider env is asserted by a curation test.
- Adding a forge/registry stays a closed, local change (a new descriptor), exhaustive at `tsc` like
  the rest of the Registry.
