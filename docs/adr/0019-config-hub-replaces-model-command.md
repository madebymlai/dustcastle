# Config hub replaces the standalone model command

## Status

accepted — implements the `dustcastle config` surface for global, editable user settings.

## Context

ADR 0009 put the pi agent model in the per-user global config at
`~/.dustcastle/config.json`, and ADR 0017 made picker cancellation an explicit outcome.
The next global setting is Credentials (ADR 0018), so a one-off `dustcastle model`
command would force either another standalone command or duplicate picker/control-flow
code.

## Decision

Introduce `dustcastle config` as the interactive hub over editable global config
settings.

- The hub contains a model action that uses the single shared model picker/write path.
- Remove the standalone `dustcastle model` command; `model` is now an unknown command.
- Hub cancellation is exit-without-write. Cancelling the menu or the model action exits
  successfully and leaves `~/.dustcastle/config.json` byte-for-byte unchanged.
- `dustcastle run` keeps its first-run auto-pick behavior from ADR 0017: cancelling that
  run-time picker aborts the run with exit 130, and headless unconfigured runs fail fast
  before provisioning.

## Consequences

- There is one explicit config entry point for future Credential actions.
- There is no parallel model-pick command path to maintain.
- The breaking CLI change is intentional: users re-pick the model with
  `dustcastle config`.
