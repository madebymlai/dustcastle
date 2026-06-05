# Model picker cancel and no-model outcomes

## Status

accepted — refines [ADR 0009](0009-no-project-local-config.md)'s global pi model picker without changing where the model is stored.

## Context

The first `dustcastle run` with no global model and the explicit `dustcastle model` command both use the pi model picker. Before the Terminal-port refactor, Ctrl-C lived inside the select widget and called `process.exit(0)`: an interrupt looked like success and the command layer could not distinguish "operator cancelled" from "pi returned no models".

The picker also has three materially different no-selection cases:

- the operator cancelled an interactive picker;
- `dustcastle model` cannot show a picker because the terminal is not interactive;
- pi returned no models, commonly because the operator has not run `pi` then `/login` yet.

ADR 0009 intentionally keeps one global model and preserves the first-run interactive picker. That path still needs the useful pi-login hint when pi has no models.

## Decision

Cancellation is a command outcome, not a widget side effect.

- The select widget resolves `undefined` on Ctrl-C and never exits the process.
- `dustcastle model` maps outcomes directly: selected → exit 0, no models / not interactive → exit 1, cancelled → exit 130.
- `dustcastle run` treats cancellation as an abort and exits 130 before provisioning further work.
- A cancellation is quiet: it is never reported as "no pi models found".
- The interactive "pi has no models" path remains distinct from cancellation and keeps the ADR 0009 hint: run `pi`, then `/login`, then re-run `dustcastle model`.
- Headless first-run with no configured model must not silently provision nothing; it prints an actionable `dustcastle model` hint, exits non-zero, and provisions nothing.

## Consequences

- Shells and wrapper scripts can now tell an operator interrupt from success.
- The leaf picker is testable because it reports values instead of killing the process.
- The command layer owns user-facing messages and exit codes.
- The pi-login hint remains available for the real interactive "no models" condition and is not shown when the operator simply cancelled or when headless configuration is missing.
