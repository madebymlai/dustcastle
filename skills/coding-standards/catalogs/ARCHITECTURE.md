# Architecture Catalog

Structural rules a reviewer can check in a diff.

→ Destination: `.sandcastle/CODING_STANDARDS.md`

## Module Boundaries

- **No Defensive Garbage** — Trust established preconditions and module contracts; let violated invariants surface as immediate failures instead of masking them with silent fallbacks.
  > Pick when: null checks and default fallbacks mask upstream bugs, defensive code hides the real source of errors, or functions silently return wrong results instead of failing.

- **Tell, Don't Ask** — Rather than querying an object's state and acting on it, tell the object what to do and let it use its own state to decide how.
  > Pick when: callers inspect an object's fields to decide what to do, logic that belongs inside a class leaks into consumers, or feature envy appears across module boundaries.

## Dependency Direction

- **Acyclic Dependencies** — The dependency graph of packages or components must contain no cycles. If A imports B, B must not import A directly or transitively.
  > Pick when: circular imports appear, test setup requires bootstrapping unrelated modules, or changing one module forces recompilation/retesting of an unrelated module.

### Sources

- [No Defensive Garbage](https://wiki.c2.com/?OffensiveProgramming) — Offensive Programming, c2 wiki
- [Tell, Don't Ask](https://martinfowler.com/bliki/TellDontAsk.html) — Martin Fowler, pragprog origin by Andy Hunt & Dave Thomas
- [Acyclic Dependencies](https://en.wikipedia.org/wiki/Acyclic_dependencies_principle) — Robert C. Martin, "Agile Software Development" (2002)
