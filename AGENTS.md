# tokf

🗜️ means this output was compressed by tokf.
Run `tokf raw last` to see the full uncompressed output of the last command.

# Principles

<!-- Pick from the catalog: skills/agentstack/catalogs/PRINCIPLES.md
     Copy the ones that apply to this project. Example:

- **SRP** — A module should have one, and only one, reason to change: responsible to one actor.
- **OCP** — Software entities should be open for extension but closed for modification.
- **KISS** — Every system works best when simplicity is a key goal and unnecessary complexity is avoided.
- **YAGNI** — Do not introduce abstractions, parameters, or code paths that serve no current caller.
- **Forward-First** — Design for the current and next contract version; never introduce backward-compatibility shims or legacy code paths.
-->

# Agent skills

## Issue tracker

  Use bd (beads) for issue tracking.

  - Run `bd prime` for workflow context and command guidance.
  - Use `bd ready`, `bd show <id>`, `bd update <id> --claim`, and `bd close <id>`.
  - Use `bd remember "insight"` for persistent project memory; do not create MEMORY.md files.
  - Use `bd dep add <blocked> --blocked-by <blocker>` for building dependecies trees across issues.
  - Do not use markdown TODO lists for task tracking.
  - `/to-prd` must create the PRD issue with `--type=epic`. Epics are containers — implement their children, not the epic itself.

## Triage labels

Two **category** roles:

 - `bug` — something is broken
 - `enhancement` — new feature or improvement

Five **state** roles:

 - `needs-triage` — maintainer needs to evaluate
 - `needs-info` — waiting on reporter
 - `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
 - `ready-for-human` — needs human implementation
 - `wontfix` — will not be actioned

## Domain docs

Domain language and terminology defined in `CONTEXT.md` at the repo root.

# Workflow
