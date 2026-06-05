import { generatePythonToolchain } from "./toolchain-nix.js";
import type {
  EcosystemDescriptor,
  LooseManifestInput,
  PackageManager,
  PackageManagerDescriptor,
} from "./types.js";

// ============================================================================
// Managers
// ============================================================================

/**
 * The shared in-Sandbox install for Python (ADR 0012): install the requirements into
 * `./site` — the dir `PYTHONPATH` points at. ONE resolving line that works whether or
 * not the requirements are pinned: pip auto-enables hash-checking when the file carries
 * `--hash=` lines (a lock-grade or uv/poetry-exported requirements.txt is still
 * verified), and resolves a loose/unpinned file rather than hard-failing on it. We do
 * NOT pass `--require-hashes` — that demands every line be `==`-pinned and would reject
 * the common hand-written requirements.txt; reproducibility is out of scope (ADR 0012).
 * Every python manager's `installCommand` ends with this; uv/poetry prepend their
 * `export` step (only ever selected when their lockfile is present, so it always exports).
 */
const PIP_INSTALL_INTO_SITE = "pip install -r requirements.txt --target site";

/** uv's in-Sandbox export step: materialise the hash-pinned requirements.txt from uv.lock. */
const UV_EXPORT = "uv export --format requirements-txt -o requirements.txt";

/** poetry's in-Sandbox export step (hashes ON by default — no `--without-hashes`). */
const POETRY_EXPORT = "poetry export --format requirements.txt -o requirements.txt";

/**
 * The Python Ecosystem descriptors (ADR 0006 + its 2026-05-30 amendment / ADR 0012).
 * Python's Toolchain is the resolved interpreter with pip + pytest; its Project Deps
 * install in-Sandbox via the sandcastle hook.
 *
 * Three Package Managers share one Toolchain expression: `pip` consumes a hash-pinned
 * `requirements.txt` directly, while `uv`/`poetry` prepend their own `export` step to
 * produce those requirements from their richer lockfile before the shared pip install.
 */

const pip: PackageManagerDescriptor = {
  packageManager: "pip",
  ecosystem: "python",
  // `requirements.txt` is consumed directly when hash-pinned (already lock-grade).
  lockfiles: ["requirements.txt"],
  generateToolchain: generatePythonToolchain,
  // The in-Sandbox install (ADR 0012). pip consumes requirements.txt directly (no
  // export step), so it is JUST the shared pip-into-site install.
  installCommand: [PIP_INSTALL_INTO_SITE],
  // Build Egress (ADR 0012): the shared pip-into-site install reads the index from
  // pypi.org and downloads wheels from files.pythonhosted.org — both must be open.
  registryHosts: ["pypi.org", "files.pythonhosted.org"],
};

/**
 * uv as a Python Package Manager (laimk-hse.6). uv shares the SAME Python Toolchain
 * (interpreter + pip + pytest); its Project Deps install in-Sandbox by first running
 * `uv export --format requirements-txt` to produce the hash-pinned requirements from
 * uv.lock, then the shared pip install (ADR 0012). `uv.lock` is a real, richer
 * lockfile that beats a co-present `requirements.txt` in detection precedence (ADR 0006d).
 */
const uv: PackageManagerDescriptor = {
  packageManager: "uv",
  ecosystem: "python",
  // uv's real lockfile; it signals uv and outranks requirements.txt (ADR 0006d).
  lockfiles: ["uv.lock"],
  generateToolchain: generatePythonToolchain,
  // The in-Sandbox install (ADR 0012): run uv's OWN export to produce the hash-pinned
  // requirements, then install them into ./site.
  installCommand: [UV_EXPORT, PIP_INSTALL_INTO_SITE],
  // Build Egress (ADR 0012): uv's install runs `pip install` into ./site, which reads
  // the index from pypi.org and downloads wheels from files.pythonhosted.org.
  registryHosts: ["pypi.org", "files.pythonhosted.org"],
};

/**
 * poetry as a Python Package Manager (laimk-hse.7). Like uv, poetry shares the SAME
 * Python Toolchain; its Project Deps install in-Sandbox by first running `poetry
 * export` to produce the hash-pinned requirements from poetry.lock, then the shared
 * pip install (ADR 0012). `poetry.lock` is a real, richer lockfile: it beats a
 * co-present `requirements.txt`, and loses to `uv.lock` (precedence uv.lock >
 * poetry.lock > requirements.txt, ADR 0006d).
 */
const poetry: PackageManagerDescriptor = {
  packageManager: "poetry",
  ecosystem: "python",
  // poetry's real lockfile; it signals poetry, outranks requirements.txt, and is
  // outranked by uv.lock (ADR 0006d: uv.lock > poetry.lock > requirements.txt).
  lockfiles: ["poetry.lock"],
  generateToolchain: generatePythonToolchain,
  // The in-Sandbox install (ADR 0012): run poetry's OWN export to produce the
  // hash-pinned requirements (hashes ON by default), then install them into ./site.
  installCommand: [POETRY_EXPORT, PIP_INSTALL_INTO_SITE],
  // Build Egress (ADR 0012): poetry's install runs `pip install` into ./site, which
  // reads the index from pypi.org and downloads wheels from files.pythonhosted.org.
  registryHosts: ["pypi.org", "files.pythonhosted.org"],
};

// Keyed by Package Manager name for the Registry's compile-time exhaustiveness
// check (architecture review candidate 2). Insertion order = lockfile precedence.
export const PYTHON_MANAGERS = { uv, poetry, pip } satisfies Partial<
  Record<PackageManager, PackageManagerDescriptor>
>;

// ============================================================================
// Ecosystem descriptor
// ============================================================================

export const PYTHON_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "python",
  // The manifest markers that say "this directory is Python" (ADR 0006a).
  manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
  // The ordering IS the lockfile precedence (ADR 0006d): uv.lock > poetry.lock >
  // requirements.txt — a repo with both uv.lock and another uses uv (laimk-hse.6),
  // a repo with poetry.lock + requirements.txt uses poetry (laimk-hse.7).
  managers: ["uv", "poetry", "pip"],
  // pip stays the fallback when no lockfile pins a manager (a bare/abstract manifest).
  defaultManager: "pip",
  // No declared-manager resolver: Python has one Package Manager in v1 (pip).
  // The Toolchain version comes from `.python-version` (an exact minor pin) and/or
  // pyproject's `requires-python` range (ADR 0006b), resolved against the pinned
  // nixpkgs' interpreter set by the standalone pure resolver (laimk-hse.3). The
  // resolver returns the nixpkgs interpreter attr (`python312`); an EOL/missing
  // minor surfaces as an ACTIONABLE error rather than a silent fallback.
  readToolchainVersion: ({ manifest, readVersionFile }) =>
    resolvePythonInterpreter({
      pythonVersion: parsePythonVersionFile(readVersionFile(".python-version")),
      requiresPython: readRequiresPython(manifest),
      available: DEFAULT_PYTHON_INTERPRETERS,
    }),
  // Loose-manifest detection (ADR 0006c, laimk-hse.5). Python needs a CONTENT-based
  // reader (not the generic manifest-without-lockfile test) because requirements.txt
  // is BOTH the manifest marker AND pip's lockfile.
  isLooseManifest: detectPythonLoose,
  // In-Sandbox install staging (ADR 0002/0012): `pip install --target site`
  // assembles site-packages in the worktree's `site` (PYTHONPATH points there). The
  // run env puts the python Toolchain (with pip) on PATH ahead of the agent harness,
  // reaches the staged site via PYTHONPATH, and points pip's cache + home at /tmp
  // since the Store is read-only.
  sandbox: {
    stageDir: "site",
    env: (bin) => ({
      // Nix Toolchain first (the PROJECT's python wins), then /usr/local/bin where
      // the image's agent harness lives (bd/pi — the implement phase shells `bd`).
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      PYTHONPATH: "site",
      PIP_CACHE_DIR: "/tmp/pip-cache",
      XDG_CACHE_HOME: "/tmp/.cache",
    }),
  },
};

// ============================================================================
// Loose detection
// ============================================================================

/**
 * Decide whether a Python directory is a LOOSE manifest (ADR 0006c). A present
 * `requirements.txt` is pip's lockfile ONLY when it is lock-grade (every requirement
 * `==`-pinned and `--hash`-bearing); a present-but-not-lock-grade file (unpinned,
 * hash-less, or mixed) is loose. With no requirements.txt, a RICHER lockfile
 * (`uv.lock` / `poetry.lock`) is lock-grade — its in-Sandbox `export` step
 * materialises the hash-pinned requirements.txt — so the project is NOT loose. Only
 * an abstract pyproject.toml/setup.py with NO lock at all is loose.
 */
function detectPythonLoose({ manifestPresent, hasLockfile, readFile }: LooseManifestInput): boolean {
  if (!manifestPresent) return false;
  const requirements = readFile("requirements.txt");
  if (requirements !== undefined) {
    // requirements.txt present: lock-grade builds pure directly; otherwise resolve.
    return !requirementsIsLockGrade(requirements);
  }
  // No requirements.txt: a uv.lock / poetry.lock is the lock (its in-Sandbox export
  // step produces requirements.txt). Loose only when there is no lock at all.
  return !hasLockfile;
}

/**
 * Whether a `requirements.txt` is lock-grade — a stable, cacheable lock (not loose).
 * True ONLY when the file declares at least one requirement AND every requirement line
 * is exactly `==`-pinned and carries at least one `--hash=` (pip's hash-checking
 * contract). An empty file, a bare package name, a loose constraint (`>=`/`~=`), a
 * hash-less pin, or any mixed line makes it NOT lock-grade — detection surfaces it as
 * loose.
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
    const line = stripRequirementsComment(raw).trim();
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
function stripRequirementsComment(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? line : line.slice(0, hash);
}

// ============================================================================
// Version resolution (PEP 440 / requires-python)
// Deliberately fenced inline here: dustcastle-f11 chose one file per Ecosystem,
// so this cohesive PEP 440 reader lives in python.ts rather than a sibling module.
// ============================================================================

/**
 * The Python Toolchain version resolver (laimk-hse.3) — a PURE deep block with no
 * Store/Nix coupling (ADR 0006b: an Ecosystem owns "how to read its Toolchain
 * version"). It has a small interface:
 *
 *   - {@link parsePythonVersionFile} reads `.python-version` to a `major.minor`
 *     (the patch / pre-release suffix is dropped — `.python-version` pins a minor);
 *   - {@link readRequiresPython} reads pyproject's `requires-python` (PEP 621) or
 *     poetry's `python` (`^`/`~` normalised to a PEP 440 range);
 *   - {@link resolvePythonInterpreter} maps `(.python-version, requires-python)`
 *     onto the HIGHEST stable `python3XX` present in the pinned nixpkgs that
 *     satisfies the constraint — an exact `.python-version` minor wins when it
 *     satisfies, no constraint resolves to the default `python3`, and an
 *     EOL/missing minor is an ACTIONABLE error, never a silent fallback.
 *
 * The available-interpreter set is DATA (a parameter), not hardcoded magic inside
 * the resolver: {@link DEFAULT_PYTHON_INTERPRETERS} is what the descriptor wires
 * in, discovered from the pinned nixpkgs (the `python3X` attrs it ships).
 */

/** A `major.minor` Python version (the grain `.python-version` and nixpkgs pin in). */
export interface PythonMinor {
  readonly major: number;
  readonly minor: number;
}

/**
 * One interpreter the pinned nixpkgs ships, as DATA: its nixpkgs attr (`python312`)
 * and its minor (`12`). `prerelease` marks a not-yet-stable interpreter that is
 * excluded from the DEFAULT candidate set (the highest-stable resolve and the
 * no-constraint default), but is still selectable by an explicit exact pin.
 */
export interface AvailableInterpreter {
  /** The nixpkgs attribute name (`python312`) — what the Importer stages. */
  readonly attr: string;
  /** The interpreter's minor (the `12` in 3.12). Major is always 3 in nixpkgs' set. */
  readonly minor: number;
  /** True for a pre-release interpreter (excluded from the default candidate set). */
  readonly prerelease?: boolean;
}

/**
 * The interpreter set discovered from the pinned nixpkgs (the `python3X` attrs it
 * ships). DATA the descriptor wires into the resolver — NOT magic inside it. The
 * Toolchain defaults to `python312` (src/ecosystems/toolchain-nix.ts); this mirrors
 * nixpkgs' stable set at that pin, with `python314` marked pre-release so it is
 * excluded by default.
 *
 * This is the one maintenance row per the pinned nixpkgs bump (ADR 0006 §
 * Consequences: "the version-file list needs per-Ecosystem maintenance").
 */
export const DEFAULT_PYTHON_INTERPRETERS: readonly AvailableInterpreter[] = [
  { attr: "python39", minor: 9 },
  { attr: "python310", minor: 10 },
  { attr: "python311", minor: 11 },
  { attr: "python312", minor: 12 },
  { attr: "python313", minor: 13 },
  { attr: "python314", minor: 14, prerelease: true },
];

/** The nixpkgs default unversioned interpreter, used when nothing constrains the version. */
const DEFAULT_INTERPRETER_ATTR = "python3";

/**
 * Read `.python-version` to a `major.minor`, dropping any patch / pre-release
 * suffix (`3.12.4` and `3.13.0rc1` both pin the minor). Returns undefined for an
 * absent / blank file or a non-CPython pin (`system`, `pypy3.10`) — those don't
 * name a `python3XX` minor the resolver can honour.
 */
export function parsePythonVersionFile(raw: string | undefined): PythonMinor | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  // major.minor, optionally followed by a patch / pre-release suffix we drop.
  const match = trimmed.match(/^(\d+)\.(\d+)(?:[.\-+a-zA-Z0-9]*)?$/);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  return { major, minor };
}

/**
 * Read pyproject's requested Python range as a normalised PEP 440 specifier
 * string. Prefers PEP 621 `[project] requires-python` (already PEP 440); falls
 * back to poetry's `[tool.poetry.dependencies] python`, normalising the poetry
 * caret/tilde shorthands (`^3.10` -> `>=3.10,<4`, `~3.11` -> `>=3.11,<3.12`).
 * Undefined when neither is declared.
 *
 * A deliberately small TOML reader: pyproject's `requires-python` / poetry `python`
 * are single quoted scalars under a known table, so a targeted line scan beats
 * pulling a full TOML parser dependency (ADR 0001: own the small engine).
 */
export function readRequiresPython(pyprojectText: string | undefined): string | undefined {
  if (pyprojectText === undefined) return undefined;

  const pep621 = readTableScalar(pyprojectText, "project", "requires-python");
  if (pep621 !== undefined) return pep621;

  const poetry = readTableScalar(pyprojectText, "tool.poetry.dependencies", "python");
  if (poetry !== undefined) return normalisePoetrySpecifier(poetry);

  return undefined;
}

/** A single resolved version constraint (no constraint when both files are silent). */
export interface ResolveInput {
  /** The `.python-version` pin (major.minor), if a version file pinned one. */
  readonly pythonVersion: PythonMinor | undefined;
  /** The normalised PEP 440 `requires-python` range, if pyproject declared one. */
  readonly requiresPython: string | undefined;
  /** The interpreters the pinned nixpkgs ships (DATA — typically DEFAULT_PYTHON_INTERPRETERS). */
  readonly available: readonly AvailableInterpreter[];
}

/**
 * Resolve the nixpkgs interpreter attr for a repo's declared Python version
 * (laimk-hse.3). The rules, in order:
 *
 *   1. An exact `.python-version` minor WINS when it is available and satisfies
 *      `requires-python` — even a pre-release minor (an explicit opt-in). A pin
 *      that conflicts with `requires-python`, or names a minor absent from the
 *      pin, is an ACTIONABLE error (never a silent fallback).
 *   2. Else a `requires-python` RANGE resolves to the HIGHEST STABLE minor that
 *      satisfies it (pre-release interpreters are excluded from this candidate
 *      set). No satisfying stable minor is an ACTIONABLE error.
 *   3. Else (no constraint) the default unversioned `python3`.
 */
export function resolvePythonInterpreter(input: ResolveInput): string {
  const { pythonVersion, requiresPython, available } = input;
  const spec = requiresPython !== undefined ? parsePep440Range(requiresPython) : undefined;

  // (1) An exact `.python-version` pin wins when it is available and satisfies.
  if (pythonVersion !== undefined) {
    if (pythonVersion.major !== 3) {
      throw new Error(
        `python: .python-version pins ${pythonVersion.major}.${pythonVersion.minor}, but dustcastle ` +
          `provisions CPython 3 only. Available: ${describeAvailable(available)}.`,
      );
    }
    if (spec !== undefined && !spec.satisfies(pythonVersion.minor)) {
      throw new Error(
        `python: .python-version pins 3.${pythonVersion.minor}, which conflicts with ` +
          `requires-python "${requiresPython}". Reconcile the two, or drop one.`,
      );
    }
    const match = available.find((i) => i.minor === pythonVersion.minor);
    if (match === undefined) {
      throw new Error(
        `python: .python-version pins 3.${pythonVersion.minor}, which is EOL or not in the pinned ` +
          `nixpkgs. Pin an available minor instead — available: ${describeAvailable(available)}.`,
      );
    }
    return match.attr;
  }

  // (2) A requires-python range -> the HIGHEST stable satisfying minor.
  if (spec !== undefined) {
    const candidate = highestStableSatisfying(available, spec);
    if (candidate === undefined) {
      throw new Error(
        `python: requires-python "${requiresPython}" is satisfied by no interpreter in the pinned ` +
          `nixpkgs. Widen the constraint — available: ${describeAvailable(available)}.`,
      );
    }
    return candidate.attr;
  }

  // (3) No constraint -> the default unversioned python3.
  return DEFAULT_INTERPRETER_ATTR;
}

/** The highest STABLE interpreter (pre-releases excluded) whose minor satisfies the spec. */
function highestStableSatisfying(
  available: readonly AvailableInterpreter[],
  spec: Pep440Range,
): AvailableInterpreter | undefined {
  return [...available]
    .filter((i) => i.prerelease !== true && spec.satisfies(i.minor))
    .sort((a, b) => b.minor - a.minor)[0];
}

/** Human-readable list of available stable minors, for the actionable errors. */
function describeAvailable(available: readonly AvailableInterpreter[]): string {
  const minors = available
    .filter((i) => i.prerelease !== true)
    .map((i) => `3.${i.minor}`)
    .sort();
  return minors.length > 0 ? minors.join(", ") : "(none)";
}

/**
 * A parsed PEP 440 range over the Python minor (we only ever resolve a minor, so
 * each clause is evaluated at `3.<minor>`, treating the patch as 0).
 */
interface Pep440Range {
  satisfies: (minor: number) => boolean;
}

/**
 * Parse a comma-separated PEP 440 specifier into a minor predicate. Supports the
 * operators `requires-python` realistically uses: `>=`, `>`, `<=`, `<`, `==`
 * (incl. the `==3.11.*` wildcard), `!=`, and `~=`. Each clause is checked against
 * the candidate `3.<minor>.0`.
 */
function parsePep440Range(specifier: string): Pep440Range {
  const clauses = specifier
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map(parseClause);
  return {
    satisfies: (minor) => clauses.every((clause) => clause(minor)),
  };
}

/** One PEP 440 clause -> a predicate over the candidate minor (major assumed 3). */
function parseClause(clause: string): (minor: number) => boolean {
  const match = clause.match(/^(>=|<=|==|!=|~=|>|<)\s*(.+)$/);
  if (match === null) {
    // An unrecognised clause is ignored rather than silently mis-resolving: it
    // can only widen, never wrongly narrow (a bad clause never fabricates a pin).
    return () => true;
  }
  const op = match[1] as string;
  const rawVersion = (match[2] as string).trim();

  // The `==3.11.*` wildcard pins the minor exactly (patch wildcarded).
  if (op === "==" && rawVersion.endsWith(".*")) {
    const target = parseVersionMinor(rawVersion.slice(0, -2));
    return target === undefined ? () => true : (minor) => minor === target.minor && target.major === 3;
  }

  const target = parseVersionMinor(rawVersion);
  if (target === undefined) return () => true;
  // Compare at the minor grain against a same-major target (nixpkgs is all major 3).
  const t = target.major === 3 ? target.minor : target.major > 3 ? Infinity : -Infinity;

  switch (op) {
    case ">=":
      return (minor) => minor >= t;
    case ">":
      // `>3.10` excludes 3.10 itself (we resolve whole minors, patch treated as 0).
      return (minor) => minor > t;
    case "<=":
      return (minor) => minor <= t;
    case "<":
      return (minor) => minor < t;
    case "==":
      return (minor) => minor === t;
    case "!=":
      return (minor) => minor !== t;
    case "~=":
      // `~=3.10` (compatible release) == `>=3.10,<4`; `~=3.10.0` == `>=3.10,<3.11`.
      return rawVersion.split(".").length >= 3 ? (minor) => minor === t : (minor) => minor >= t;
    default:
      return () => true;
  }
}

/** Parse a `3` / `3.11` / `3.11.2` version head to a `major.minor` (minor defaults 0). */
function parseVersionMinor(raw: string): PythonMinor | undefined {
  const match = raw.trim().match(/^(\d+)(?:\.(\d+))?/);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = match[2] !== undefined ? Number(match[2]) : 0;
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  return { major, minor };
}

/**
 * Normalise a poetry version constraint (`^3.10`, `~3.11`, or a bare PEP 440
 * clause) to a PEP 440 range string. Poetry's caret/tilde shorthands are NOT
 * PEP 440 (PEP 440 has no `^`/`~` for Python), so we expand them:
 *   - `^3.10` -> `>=3.10,<4`   (compatible up to the next MAJOR)
 *   - `~3.11` -> `>=3.11,<3.12` (compatible up to the next MINOR)
 * Anything else is passed through (already a PEP 440 clause like `>=3.9`).
 */
function normalisePoetrySpecifier(constraint: string): string {
  const trimmed = constraint.trim();

  if (trimmed.startsWith("^")) {
    const v = parseVersionMinor(trimmed.slice(1));
    if (v === undefined) return trimmed;
    return `>=${v.major}.${v.minor},<${v.major + 1}`;
  }

  if (trimmed.startsWith("~")) {
    const v = parseVersionMinor(trimmed.slice(1));
    if (v === undefined) return trimmed;
    return `>=${v.major}.${v.minor},<${v.major}.${v.minor + 1}`;
  }

  return trimmed;
}

/**
 * Read a single quoted scalar (`key = "value"`) under a known TOML table header.
 * A targeted, dependency-free scan: find `[table]`, then the first `key =` line
 * before the next table header. Returns the unquoted value, or undefined.
 */
function readTableScalar(text: string, table: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const tableHeader = `[${table}]`;
  let inTable = false;
  for (const line of lines) {
    const stripped = stripTomlComment(line).trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith("[")) {
      inTable = stripped === tableHeader;
      continue;
    }
    if (!inTable) continue;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    if (stripped.slice(0, eq).trim() !== key) continue;
    return unquote(stripped.slice(eq + 1).trim());
  }
  return undefined;
}

/** Drop a trailing `# comment` not inside a quoted string (TOML scalars are simple here). */
function stripTomlComment(line: string): string {
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString !== undefined) {
      if (ch === inString) inString = undefined;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Strip matching single or double quotes from a TOML scalar; pass through otherwise. */
function unquote(value: string): string | undefined {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value.length > 0 ? value : undefined;
}
