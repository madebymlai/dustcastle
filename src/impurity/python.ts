/**
 * The Python impurity-signal reader (ADR 0004 + ADR 0006 amendment) — a
 * standalone, pure `lockText → needsImpurity` module, the Python analogue of
 * `npmLockNeedsImpurity` / `pnpmLockNeedsImpurity`.
 *
 * The pip-FOD Importer builds pure with `pip download --only-binary=:all:`:
 * wheels run NO install-time code, so offline assembly is pure by construction.
 * A package is therefore impure for dustcastle EXACTLY when no compatible WHEEL
 * exists for the target — it ships only an sdist (`.tar.gz` / `.zip`), which
 * would have to be BUILT from source during download, the one thing
 * `--only-binary=:all:` forbids. Such a package can't be satisfied by the pure
 * FOD and routes to the existing impure container path (allow/ask/deny + scoped
 * egress, ADR 0004/0005) — never a silent failure.
 *
 * The ABI tag in a wheel filename marks native vs pure-Python, but for the
 * wheel-vs-sdist decision the load-bearing fact is simply "is there any wheel" —
 * a native wheel is still pure to assemble offline.
 *
 * `uv.lock` and `poetry.lock` are TOML, but ADR 0001 forbids a heavyweight
 * parser, so we scan them as text (mirroring the owned pnpm-lock.yaml scan in
 * `pnpmLockNeedsImpurity`). Conservative throughout: anything unparseable, empty,
 * or undefined is treated as pure — impurity only ever ADDS gating, and
 * `--only-binary=:all:` keeps the pure FOD honest at build time regardless.
 */

/**
 * Whether a `uv.lock` needs an impure build (ADR 0004). uv.lock is TOML: each
 * `[[package]]` block may carry a `[package.sdist]` table and/or a
 * `[[package.wheels]]` array. A package is sdist-only — and so impure — when its
 * block declares an sdist but no wheels. A block with neither (a local/virtual
 * project root) builds nothing and stays pure.
 */
export function uvLockNeedsImpurity(lockText: string | undefined): boolean {
  if (typeof lockText !== "string" || lockText.trim() === "") return false;
  return splitTomlPackages(lockText).some((block) => {
    const hasSdist = /^\s*\[package\.sdist\]/m.test(block);
    const hasWheel = /^\s*\[\[package\.wheels\]\]/m.test(block);
    return hasSdist && !hasWheel;
  });
}

/**
 * Whether a `poetry.lock` needs an impure build (ADR 0004). poetry.lock is TOML:
 * each `[[package]]` block lists every artifact by filename. A package is
 * sdist-only — and so impure — when it has a files listing whose entries are all
 * sdists (`.tar.gz` / `.zip`) with no `.whl`. A block with no files listing builds
 * nothing and stays pure.
 *
 * Real poetry (2.x, lock-version 2.1) emits an inline `files = [{file = "…"}, …]`
 * ARRAY; older poetry (lock-version 2.0) emitted a `[package.files]` sub-table of
 * `"<filename>" = "<hash>"`. `filenamesInFilesSection` reads BOTH (laimk-hse.7
 * spike: the wheels-only `poetry export → pip-FOD` path was validated against real
 * poetry 2.4.1, whose array form the old table-only scan silently missed — every
 * real lock read as pure, hiding a genuine sdist-only dep).
 */
export function poetryLockNeedsImpurity(lockText: string | undefined): boolean {
  if (typeof lockText !== "string" || lockText.trim() === "") return false;
  return splitTomlPackages(lockText).some((block) => {
    const files = filenamesInFilesSection(block);
    if (files.length === 0) return false;
    return !files.some((name) => name.endsWith(".whl"));
  });
}

/**
 * Whether a `requirements.txt` needs an impure build (ADR 0004). requirements.txt
 * carries NO in-file wheel-vs-sdist signal, so the static answer is conservative:
 * always pure. The pure FOD's `--only-binary=:all:` keeps that honest at build
 * time — an sdist-only dep hard-fails the hash-pinned download and surfaces,
 * rather than silently building from source.
 */
export function requirementsNeedsImpurity(_lockText: string | undefined): boolean {
  return false;
}

/**
 * Split TOML lock text into per-`[[package]]` blocks (text scan, no parser — ADR
 * 0001). Each block runs from one `[[package]]` header up to (but not including)
 * the next, so its nested `[package.sdist]` / `[package.files]` sub-tables stay
 * attached to the package they describe.
 */
function splitTomlPackages(lockText: string): readonly string[] {
  const lines = lockText.split("\n");
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^\s*\[\[package\]\]\s*$/.test(line)) {
      if (current !== undefined) blocks.push(current.join("\n"));
      current = [];
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  if (current !== undefined) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Collect the artifact filenames a poetry `[[package]]` block lists, across both
 * lock formats (the block is already isolated by `splitTomlPackages`, so a
 * whole-block scan can't bleed across packages):
 *   - poetry 2.x (lock-version 2.1): `files = [{file = "name", hash = "…"}, …]`
 *   - poetry <2.x (lock-version 2.0): a `[package.files]` sub-table of
 *     `"name-1.0.tar.gz" = "sha256:…"`
 * Both pin the filename in a quoted string, so we read it off each `file = "…"`
 * field (array form) or each `"<filename>.{whl,tar.gz,…}" =` key (table form).
 * Only artifact lines carry such tokens — `name`/`version`/`extras` lines don't.
 */
function filenamesInFilesSection(block: string): readonly string[] {
  const names: string[] = [];
  for (const line of block.split("\n")) {
    // array form: `{ file = "name-1.0.tar.gz", hash = "..." }`
    const fileField = /\bfile\s*=\s*"([^"]+)"/.exec(line);
    if (fileField?.[1] !== undefined) {
      names.push(fileField[1]);
      continue;
    }
    // table-key form: `name-1.0-py3-none-any.whl = "sha256:..."`
    const key = /^\s*"?([^"=\s]+\.(?:whl|tar\.gz|zip|tar\.bz2))"?\s*=/.exec(line);
    if (key?.[1] !== undefined) names.push(key[1]);
  }
  return names;
}
