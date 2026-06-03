# Testing Catalog

Concrete testing conventions a reviewer can check in a diff.

→ Destination: `.sandcastle/CODING_STANDARDS.md`

## Structure

- **Arrange-Act-Assert** — Structure every test in three distinct phases: set up inputs, execute the behavior, verify the outcome. Do not interleave assertions with setup or actions.
  > Pick when: tests mix setup and assertions, test methods are hard to scan, or the boundary between "what's being tested" and "what's being checked" is unclear.

## Scope

- **One Behavior Per Test** — Each test should have a single reason to fail. If a test fails, the name alone must identify what broke. One behavior means one stimulus, not necessarily one assertion.
  > Pick when: tests have 5+ unrelated assertions, a single failure message doesn't tell you what broke, or test names use "and" to describe multiple behaviors.

## Assertions

- **Test Behavior Not Implementation** — Assert on observable outcomes and side effects, not on internal method calls or private state. Tests that verify implementation details break when code is refactored without changing behavior.
  > Pick when: tests mock internal methods and assert they were called, tests break on refactors that preserve behavior, or tests verify private state instead of public output.

## Reliability

- **Deterministic Tests** — Tests must produce the same result on every run. Do not depend on wall-clock time, random values, network availability, filesystem ordering, or execution order.
  > Pick when: `Date.now()`, `Math.random()`, or real network calls appear in tests, tests pass locally but fail in CI, or test results change between runs without code changes.

- **Test Isolation** — Tests must not depend on execution order or shared mutable state. Each test sets up its own preconditions and cleans up after itself.
  > Pick when: tests fail when run individually but pass in suite (or vice versa), `beforeAll` sets state consumed by multiple tests without `beforeEach` reset, or tests write to shared variables.

### Sources

- [Arrange-Act-Assert](https://automationpanda.com/2020/07/07/arrange-act-assert-a-pattern-for-writing-good-tests/) — Bill Wake, industry standard since ~2001
- [One Behavior Per Test](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-best-practices) — Microsoft .NET testing best practices
- [Test Behavior Not Implementation](https://testing.googleblog.com/2013/08/testing-on-toilet-test-behavior-not.html) — Google Testing Blog (2013)
- [Deterministic Tests](https://martinfowler.com/articles/nonDeterminism.html) — Martin Fowler, "Eradicating Non-Determinism in Tests"
- [Test Isolation](https://brightsec.com/blog/unit-testing-best-practices/) — industry standard practice
