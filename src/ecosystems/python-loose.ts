/**
 * The Python loose-manifest predicate (laimk-hse.5, ADR 0006c) — a standalone,
 * PURE module, the Python analogue of `python-version.ts`.
 *
 * In Python, `requirements.txt` is BOTH the Ecosystem's manifest marker AND pip's
 * lockfile, so the generic "manifest-present-but-no-lockfile" loose test (which
 * works for Node's package.json) cannot decide Python's loose case. The grain that
 * matters is CONTENT, not presence: a `requirements.txt` counts as a real lockfile
 * ONLY when it is lock-grade — every requirement `==`-pinned and `--hash=`-bearing.
 * An unpinned, hash-less, or mixed file is resolvable-but-unpinned, i.e. LOOSE.
 *
 * The install no longer branches on this (ADR 0012, dustcastle-6ta): a single
 * resolving `pip install -r requirements.txt` handles both — pip auto-verifies the
 * hashes of a lock-grade file and resolves a loose one. Lock-grade-ness now governs
 * ONE thing: CACHEABILITY. A lock-grade file has a stable content hash, so its
 * assembled deps are cached by it; a loose file resolves afresh (versions can drift),
 * so it has no stable key and is never cached (see `depsCacheKey`).
 *
 * Conservative throughout: anything undefined/empty/unparseable reads NOT
 * lock-grade, so it is treated as loose (resolve + never cache) rather than silently
 * trusting a half-pinned file as a stable lockfile.
 */

/**
 * Whether a `requirements.txt` is lock-grade — a stable, cacheable lock (not loose).
 * True ONLY when the file declares at least one requirement AND every requirement line
 * is exactly `==`-pinned and carries at least one `--hash=` (pip's hash-checking
 * contract). An empty file, a bare package name, a loose constraint (`>=`/`~=`), a
 * hash-less pin, or any mixed line makes it NOT lock-grade — it resolves afresh and is
 * not cached.
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
