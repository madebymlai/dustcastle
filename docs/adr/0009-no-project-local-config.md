# No project-local config: the agent model is a global, operator-level choice

dustcastle has **no project-local config file**. The one thing a user configures —
which pi model the agent runs — is a **single global setting** at
`~/.dustcastle/config.json`, chosen through `dustcastle config` and used by every project
on the machine. A repo never carries a dustcastle config, and `dustcastle run` reads
the same model whether you run it in one project or fifty.

This extends the config-less interface already pinned by [ADR 0002](0002-consume-sandcastle-via-provider-factories.md)
(the surface is one zero-argument command, not a config-driven API) and
[ADR 0005](0005-sandbox-secrets-and-egress.md) (secrets and egress are *derived* or
injected, **never** a dustcastle config file). ADR 0002 settled *that* there are no
per-project arguments; this ADR settles *where the one real setting lives* — and the
answer is "with the operator, globally," not "in the repo."

## Why the model is operator-global, not per-project

**The choice belongs to the human running agents, not to the codebase.** Which model
(`deepseek/deepseek-v4-pro`, an OpenAI route, etc.) you let loose on your work is a
function of *your* account, budget, and trust — not a property of the repository. Two
people pointing dustcastle at the same repo will rightly use different models; the
same person wants the same model across all their repos. That is the textbook shape of
a **per-user**, not per-project, setting.

**The auth it pairs with is already global.** pi authentication lives at `~/.pi/agent`
(host-side `pi login`), which dustcastle mounts into every sandbox ([Slice 5](../v1-status.md)).
The model selector is meaningless without that login, and the login is one global
identity. Splitting the model into per-repo files while the credential stays global
would scatter half of one decision across every checkout.

**A committed config is a leak and a foot-gun.** A `.dustcastle/`-style config tracked
in the repo would publish the operator's model/agent choices to everyone who clones it,
invite per-repo drift, and tempt people to put credentials next to it — the exact
failure ADR 0005 forbids ("never a dustcastle config file"). An *un*-committed per-repo
config is worse: invisible, unsynced state you must recreate in every clone and every
fresh worktree, defeating "configure once."

**"Install once, use everywhere" only holds if you also *configure* once.** dustcastle's
whole thesis is a single shared, deduplicated Store instead of per-project setup
([ADR 0008](0008-rootless-store-install.md)). A per-project model config would reintroduce
exactly the per-project ceremony the Store abolishes — you'd re-pick a model for each
repo. One global choice keeps the promise honest at the UX layer, the same way the
shared Store keeps it at the toolchain layer.

**The task is not config.** The only legitimately per-run input is *what to do*, and
that is sandcastle's domain (a prompt/template), supplied globally and optionally
([Slice 5](../v1-status.md)) or by sandcastle's own flow — not a dustcastle knob. So
nothing project-shaped is left over to justify a repo-local file.

## Considered Options

- **A committed project config (`.dustcastle/config.json` in the repo).** Rejected —
  leaks operator/model choices into every clone, drifts per-repo, and reopens the
  "credentials in a repo file" hazard ADR 0005 closes. The repo is the wrong owner for
  an operator decision.
- **An un-committed per-project config.** Rejected — invisible, must be recreated per
  clone/worktree, and breaks "configure once" while adding a stateful surface with no
  upside over the global file.
- **Environment variables only (the v1 `DUSTCASTLE_MODEL` stopgap).** Rejected as the
  *primary* mechanism — env is fine for a one-off override but is per-shell, easy to
  forget, and gives no discoverable picker. It does not survive across the many
  unattended `dustcastle run` invocations an operator makes. (An env override may still
  be offered as a thin escape hatch without changing the global default.)
- **One global config + a picker (chosen).** `dustcastle config` lists pi's models and
  writes `~/.dustcastle/config.json`; first `dustcastle run` picks one automatically.
  The model lives beside the global `pi` login and the global Store — all three are
  per-user, set once, used everywhere.

## Consequences

- There is exactly **one** place a model can come from, so behavior is identical across
  projects and reproducible from a known file — no hunting for an overriding repo config.
- Repos stay **dustcastle-free**: nothing to commit, `.gitignore`, or strip. dustcastle
  leaves no footprint in the codebase it operates on, matching the agent-invisible stance
  of [ADR 0002](0002-consume-sandcastle-via-provider-factories.md).
- The global config is the natural home for any *future* global setting (a default task
  prompt, an impurity default), but the bar to add one is high — every key there must be
  a genuine per-user choice, never a per-project leak. Per-project behavior should keep
  being **derived** (detection, egress) rather than configured, per [ADR 0006](0006-ecosystem-detection-owned-lockfile-router.md).
- Multi-tenant or CI hosts that genuinely need per-invocation variation use an explicit
  override (env), not a config file — keeping the "no project-local config" invariant
  intact while leaving an escape hatch.
