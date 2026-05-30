/**
 * The Python loose-manifest predicate (laimk-hse.5, ADR 0006c) — a standalone,
 * PURE module, the Python analogue of `python-version.ts` / `impurity/python.ts`.
 *
 * In Python, `requirements.txt` is BOTH the Ecosystem's manifest marker AND pip's
 * lockfile, so the generic "manifest-present-but-no-lockfile" loose test (which
 * works for Node's package.json) cannot decide Python's loose case. The grain that
 * matters is CONTENT, not presence: a `requirements.txt` is the pip-FOD's lockfile
 * ONLY when it is lock-grade — every requirement `==`-pinned and `--hash=`-bearing
 * (the pip-FOD's `pip download --require-hashes` contract). An unpinned, hash-less,
 * or mixed file is resolvable-but-unpinned and routes pin-then-pure (resolved ONCE
 * into a hash-pinned requirements.txt via `uv pip compile --generate-hashes`, then
 * built pure) — strictly better than going impure (ADR 0004).
 *
 * Conservative throughout: anything undefined/empty/unparseable reads NOT
 * lock-grade, so the loose path (a visible, reproducible pinning step) is preferred
 * over silently treating a half-pinned file as a lockfile.
 */

/**
 * Whether a `requirements.txt` is lock-grade — directly consumable by the pip-FOD
 * without a pin-then-pure resolve. True ONLY when the file declares at least one
 * requirement AND every requirement line is exactly `==`-pinned and carries at
 * least one `--hash=` (the `--require-hashes` contract). An empty file, a bare
 * package name, a loose constraint (`>=`/`~=`), a hash-less pin, or any mixed line
 * makes it NOT lock-grade — it needs pinning.
 */
export function requirementsIsLockGrade(text: string | undefined): boolean {
  if (typeof text !== "string") return false;
  const requirements = requirementLines(text);
  if (requirements.length === 0) return false;
  return requirements.every(isHashPinnedRequirement);
}

/**
 * The concrete requirement lines of a requirements.txt: the package specs, with
 * each line's trailing line-continuation (`\`) and inline `--hash=` options folded
 * back onto the spec they belong to. Comments, blank lines, and standalone pip
 * option lines (`--index-url …`, `-r other.txt`) are dropped — they declare no
 * requirement.
 */
function requirementLines(text: string): readonly string[] {
  // Fold backslash line-continuations so a spec and its indented `--hash=` lines
  // (the `uv pip compile` layout) read as ONE logical requirement.
  const logical = text.replace(/\\\r?\n/g, " ");
  const out: string[] = [];
  for (const raw of logical.split("\n")) {
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;
    // A standalone pip option line (begins with `-`) is config, not a requirement.
    if (line.startsWith("-")) continue;
    out.push(line);
  }
  return out;
}

/**
 * A requirement is lock-grade when it is exactly `==`-pinned (not `>=`/`~=`/bare)
 * and carries at least one `--hash=`. The spec text is the part before the first
 * `--hash`, so we test the pin on that head and the hash on the whole line.
 */
function isHashPinnedRequirement(line: string): boolean {
  const head = line.split("--hash")[0] ?? line;
  const exactlyPinned = /==\s*[^=\s]/.test(head) && !/[<>~!]=|[<>](?!=)/.test(head);
  const hashed = /--hash=/.test(line);
  return exactlyPinned && hashed;
}

/** Drop a `#` comment, honouring that a `#` inside a hash value never occurs (hashes are hex). */
function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}
