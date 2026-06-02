/**
 * The Python Toolchain version resolver (laimk-hse.3) — a standalone, PURE deep
 * module with no Store/Nix coupling (ADR 0006b: an Ecosystem owns "how to read its
 * Toolchain version"). It has a small interface:
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
    const stripped = stripComment(line).trim();
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
function stripComment(line: string): string {
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
