---
name: coding-standards
description: Coding standards writer — interactively select a project's style and testing standards from curated catalogs and write or update its CODING_STANDARDS.md so the code-review agent enforces them. Use when defining or revising line-level coding conventions for review, or when a repo has no coding-standards file.
---

<purpose>
A coding standards writer. Probe the codebase, propose standards one menu at a time, let the user accept or reject each, then write the accepted set to the project's coding-standards file. That file is read by the code-review agent and enforced only during review — zero token cost during implementation.
</purpose>

<rules>
- All user interaction via direct questions — one catalog section at a time.
- Accumulate accepted items in memory; write the file only at the end.
- Explain what you found in the codebase before each recommendation.
- Recommend, don't gatekeep: surface the full menu, flag the items the code argues for, but let the user pick freely (including items you didn't flag, and skipping ones you did).
- Standards are imperative one-liners a reviewer can check against a diff — not aspirations.
</rules>

<phase name="locate">
The target file is `CODING_STANDARDS.md` at the repo root.

Then look at the target file:

- **If it exists** — read it. Treat its current standards as already-decided: do not re-propose them. The session is then an *update* — you are adding to (or, if the user asks, revising) the existing set.
- **If it is missing** — this is a fresh write; you will create it at the end.

Tell the user the path you'll write and whether you're creating or updating.
</phase>

## Catalogs

Read both for the full menu. Each item carries a one-line definition and a `> Pick when:` signal describing the code smell it addresses.

- [catalogs/STYLE.md](catalogs/STYLE.md) — control flow, error handling, duplication
- [catalogs/TESTING.md](catalogs/TESTING.md) — structure, scope, assertions, reliability

<phase name="present">
Show the user each catalog's items, grouped by section, with the name and its one-line definition. Skip any item already present in the target file (from the locate phase). Keep it scannable — the user is choosing from a menu, not reading an essay.
</phase>

<phase name="recommend">
Probe the codebase before recommending. Use the codebase-memory MCP tools first (`get_architecture`, `search_code`, `search_graph`), and read any linter/formatter configs (eslint, prettier, ruff, clippy, etc.). Flag the catalog items whose `> Pick when:` signal matches evidence you actually found — and say what evidence. Do not hide the items you didn't flag.
</phase>

<phase name="select">
The user picks which standards they want. They may pick items you didn't recommend, or skip ones you did. Confirm the final set before writing.
</phase>

<phase name="write">
Write the selected standards to the target file from the locate phase, grouped by the same section headers as the catalogs, each as an imperative one-liner. When updating an existing file, merge the new items under their sections without disturbing what's already there. When creating, create `CODING_STANDARDS.md` at the repo root. Do not include the `> Pick when:` signals or source links — only the imperative rules the reviewer enforces.
</phase>

<phase name="summary">
Report what was written: the OS detected, the path, whether it was created or updated, and the list of standards grouped by section. Note that the review agent picks the file up automatically on the next review.
</phase>
