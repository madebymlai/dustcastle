# Style Catalog

Concrete conventions a reviewer can check in a diff.

→ Destination: `.sandcastle/CODING_STANDARDS.md`

## Control Flow

- **Guard Clauses** — Exit early on precondition failure instead of nesting the happy path. Guard clauses are the structural pattern for implementing Fail Fast at the function level.
  > Pick when: functions nest 3+ levels deep, the happy path is buried inside conditionals, or precondition checks wrap the entire function body.

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

- [Guard Clauses](https://deviq.com/design-patterns/guard-clause/) — DevIQ, "Return Early Pattern"
- [No Silent Error Swallowing](https://www.jamesshore.com/v2/blog/2004/fail-fast) — corollary of Fail Fast, Jim Shore (2004)
- [Explicit Error Types](https://doc.rust-lang.org/book/ch09-00-error-handling.html) — popularized by Rust's Result/Option pattern
- [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) — Jim Shore, IEEE Software (2004)
- [DRY](https://en.wikipedia.org/wiki/Don't_repeat_yourself) — Andy Hunt & Dave Thomas, "The Pragmatic Programmer" (1999)
