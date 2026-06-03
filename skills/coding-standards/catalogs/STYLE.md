# Style Catalog

Concrete conventions a reviewer can check in a diff.

→ Destination: `CODING_STANDARDS.md` (repo root)

## Naming

- **Ubiquitous-Language Names** — Name things in the domain's language so the name reveals intent without a comment; use the same term the domain and the rest of the code already use for a concept.
  > Pick when: code uses technical jargon (`data`, `mgr`, `tmp`, `process()`) where a domain term exists, a name needs a comment to explain it, or one concept goes by different names in different places.

## Control Flow

- **Guard Clauses** — Exit early on precondition failure instead of nesting the happy path. Guard clauses are the structural pattern for implementing Fail Fast at the function level.
  > Pick when: functions nest 3+ levels deep, the happy path is buried inside conditionals, or precondition checks wrap the entire function body.

- **Single Level of Abstraction** — Keep every statement in a function at the same level of abstraction; push lower-level steps down into named helpers so the body reads as an outline of what it does.
  > Pick when: a function mixes high-level orchestration with low-level detail, fiddly logic sits beside calls to well-named helpers, or you must read the whole body to grasp its shape.

## Error Handling

- **No Silent Error Swallowing** — Never catch an exception and discard it without logging, re-raising, or making the failure visible; every error must produce an observable signal.
  > Pick when: empty catch blocks exist, errors disappear into void, or `catch (e) {}` appears in the codebase.

- **Explicit Error Types** — Represent each distinct failure mode as a named, typed value in the return signature rather than relying on generic exceptions or sentinel values.
  > Pick when: callers catch generic `Error` and inspect message strings, error handling relies on sentinel values like `-1` or `null`, or failure modes are undocumented.

- **Fail Fast** — Detect and report errors at the earliest possible point rather than allowing bad state to propagate.
  > Pick when: bad input travels through multiple layers before causing a crash, or invalid state silently corrupts downstream data.

## Duplication

- **DRY** — Every piece of knowledge must have a single, unambiguous, authoritative representation within a system.
  > Pick when: the same logic or constant is copy-pasted across files, a business rule change requires updating multiple locations, or definitions drift apart silently.

### Sources

- [Ubiquitous-Language Names](https://martinfowler.com/bliki/UbiquitousLanguage.html) — Eric Evans, "Domain-Driven Design" (2003)
- [Guard Clauses](https://deviq.com/design-patterns/guard-clause/) — DevIQ, "Return Early Pattern"
- [Single Level of Abstraction](https://www.oreilly.com/library/view/the-productive-programmer/9780596519780/ch13.html) — Kent Beck, "Smalltalk Best Practice Patterns" (Composed Method); SLAP acronym coined by Glenn Vanderburg
- [No Silent Error Swallowing](https://www.jamesshore.com/v2/blog/2004/fail-fast) — corollary of Fail Fast, Jim Shore (2004)
- [Explicit Error Types](https://doc.rust-lang.org/book/ch09-00-error-handling.html) — popularized by Rust's Result/Option pattern
- [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) — Jim Shore, IEEE Software (2004)
- [DRY](https://en.wikipedia.org/wiki/Don't_repeat_yourself) — Andy Hunt & Dave Thomas, "The Pragmatic Programmer" (1999)
