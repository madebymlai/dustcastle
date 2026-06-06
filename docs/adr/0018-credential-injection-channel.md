# Credential injection channel

## Status

accepted — initial tracer bullet ships GitHub token injection end-to-end.

## Context

Some projects depend on private git-host repositories (for example a Python `uv.lock`
entry that resolves to a private GitHub HTTPS repo). dustcastle sandboxes intentionally
inherit no ambient host credentials, so a build cannot rely on host env, `~/.ssh`, or
user git config.

## Decision

Add a dustcastle-owned Credential channel: a closed, curated registry of recognised
Credentials, stored as per-user plaintext values in `~/.dustcastle/config.json` and
injected into every sandbox.

The first descriptor is GitHub:

- env key: `GITHUB_TOKEN`
- git host scope: `https://github.com`
- Basic-auth username: `x-access-token`

`dustcastle config` gains a `Credentials` action that lists the catalog and prompts the
operator for a value. Values are persisted under `credentials` in the global config,
preserving unrelated keys.

On run, dustcastle injects the credential value into the podman provider env and wires
git via ambient `GIT_CONFIG_*` entries for
`credential.https://github.com.helper`. The helper prints the username plus
`password=$GITHUB_TOKEN`; the token value is not embedded in git URLs or the helper
config string.

Credential env keys are checked against the agent provider's env before provisioning,
so a future provider cannot silently clobber a Credential value.

## Consequences

- Private GitHub HTTPS clones can authenticate inside the sandbox without inheriting
  arbitrary host credentials.
- Credential values are deliberately plaintext user-global config: explicit, simple,
  and scoped to the curated catalog rather than a free-form env passthrough.
- Scoped egress is not involved (ADR 0020); this channel is token injection + git
  credential-helper wiring only.
