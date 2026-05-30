import { generatePythonBuild } from "../nix/python.js";
import { poetryLockNeedsImpurity, requirementsNeedsImpurity, uvLockNeedsImpurity } from "../impurity/index.js";
import { requirementsIsLockGrade } from "./python-loose.js";
import {
  DEFAULT_PYTHON_INTERPRETERS,
  parsePythonVersionFile,
  readRequiresPython,
  resolvePythonInterpreter,
} from "./python-version.js";
import type {
  EcosystemDescriptor,
  ExportFrontEnd,
  LooseManifestInput,
  PackageManager,
  PackageManagerDescriptor,
} from "./types.js";

/**
 * The shared impure in-container install for Python (ADR 0004/0005): install the
 * committed/exported, hash-pinned requirements into `./site` — the SAME dir the
 * pure path stages into and `PYTHONPATH` points at, so the run env is identical
 * pure or impure. `--require-hashes` enforces the no-drift invariant (the install
 * can't resolve versions beyond the hash-pinned export). Every python manager's
 * `impureInstall` ends with this; uv/poetry prepend their export step.
 */
const PIP_INSTALL_INTO_SITE = "pip install --require-hashes -r requirements.txt --target site";

/** Render an {@link ExportFrontEnd} as the single shell command string the impure path runs. */
const exportCommand = (front: ExportFrontEnd): string => [front.command, ...front.args].join(" ");

/**
 * The Python Ecosystem descriptors (ADR 0006 + its 2026-05-30 amendment). The
 * Python Importer is a single pip fixed-output derivation (the pip-FOD) — the
 * `fetchNpmDeps` analogue, NOT uv2nix/poetry2nix (external flake inputs would
 * break the nixpkgs-via-`fetchTarball`-only invariant).
 *
 * Two Package Managers feed this one Importer: `pip` consumes a hash-pinned,
 * wheels-only `requirements.txt` directly, and `uv` is an export FRONT-END
 * (`uv export --format requirements-txt`) producing those same requirements from
 * `uv.lock` (laimk-hse.6) — NOT uv2nix. poetry (another export front-end) is a
 * later child of laimk-hse; it extends this file the same way uv does.
 */

const pip: PackageManagerDescriptor = {
  packageManager: "pip",
  ecosystem: "python",
  // The pip-FOD is the Python Importer (ADR 0006 amendment) — one network-ON
  // wheelhouse download + an offline `pip install --no-index` assembly — emitted
  // by generateBuild below.
  // `requirements.txt` is consumed directly when hash-pinned (already lock-grade).
  lockfiles: ["requirements.txt"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
      // Build against the interpreter the resolver picked (laimk-hse.3); the pip-FOD
      // defaults to python312 only when detection found no version.
      ...(ctx.toolchainVersion !== undefined ? { interpreter: ctx.toolchainVersion } : {}),
    }),
  // The pip-FOD has one discoverable aggregate hash; it lands in `pythonDepsHash`
  // (rather than overloading npmDepsHash) — ADR 0006 amendment, hash-field note.
  outputHashField: "pythonDepsHash",
  // The lockfile-read impurity signal (ADR 0004, laimk-hse.4). pip consumes
  // `requirements.txt` directly, which carries NO in-file wheel-vs-sdist signal,
  // so the static reader is conservative-pure. The pure FOD's `--only-binary=:all:`
  // keeps that honest at build time: an sdist-only / no-wheel dep hard-fails the
  // hash-pinned download and routes to the existing impure container path
  // (allow/ask/deny + scoped egress, ADR 0004/0005) — never a silent build from
  // source. The richer uv.lock/poetry.lock wheel-vs-sdist readers live in
  // `src/impurity/python.ts` and become each manager's signal when uv/poetry land
  // as Package Managers (later children of laimk-hse).
  impuritySignal: {
    lockfile: "requirements.txt",
    needsImpurity: (lockText) => requirementsNeedsImpurity(lockText),
  },
  // Loose-manifest pin-then-pure (ADR 0006c, laimk-hse.5). A loose Python manifest
  // — an unpinned/hash-less requirements.txt or an abstract pyproject with no lock —
  // is resolved ONCE into a VISIBLE, hash-pinned requirements.txt via `uv pip
  // compile --generate-hashes` (the validated spike command), after which every
  // build runs pure/offline through the pip-FOD above. `requirements.in` is the
  // conventional loose source uv compiles FROM; `-o requirements.txt` writes the
  // committed lock IN PLACE so it shows up in `git status` / the PR diff — never
  // silent (ADR 0004). uv is a pure export front-end here, NOT a separate Importer.
  lockOnlyResolve: {
    kind: "command",
    command: "uv",
    args: ["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"],
    lockfile: "requirements.txt",
  },
  // The impure in-container install (ADR 0004/0005). pip consumes requirements.txt
  // directly (no export front-end), so it is JUST the shared pip-into-site install.
  impureInstall: [PIP_INSTALL_INTO_SITE],
};

/**
 * uv as a Python Package Manager (laimk-hse.6). uv is an EXPORT FRONT-END to the
 * SAME pip-FOD Importer, NOT uv2nix — `uv export --format requirements-txt`
 * produces the hash-pinned requirements (carried as `exportFrontEnd` descriptor
 * data), which then feed the identical `generatePythonBuild` pip-FOD as pip. This
 * keeps the nixpkgs-via-`fetchTarball`-only invariant (ADR 0006 amendment / ADR 0001):
 * no external flake input. `uv.lock` is a real, richer lockfile that beats a
 * co-present `requirements.txt` in detection precedence (ADR 0006d).
 */
// uv's export front-end, named so both `exportFrontEnd` and the impure
// `impureInstall` derive from ONE source (no duplicated export string).
const uvExport: ExportFrontEnd = {
  command: "uv",
  args: ["export", "--format", "requirements-txt", "-o", "requirements.txt"],
  requirementsFile: "requirements.txt",
};

const uv: PackageManagerDescriptor = {
  packageManager: "uv",
  ecosystem: "python",
  // The Importer is the pip-FOD (same as pip) — uv only changes how the hash-pinned
  // requirements get PRODUCED (the export front-end below), never how they're built.
  // uv's real lockfile; it signals uv and outranks requirements.txt (ADR 0006d).
  lockfiles: ["uv.lock"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
      // Build against the interpreter the resolver picked (laimk-hse.3); the pip-FOD
      // defaults to python312 only when detection found no version.
      ...(ctx.toolchainVersion !== undefined ? { interpreter: ctx.toolchainVersion } : {}),
    }),
  // The same single aggregate pip-FOD hash, landing in pythonDepsHash (not npmDepsHash).
  outputHashField: "pythonDepsHash",
  // The export front-end (ADR 0006 amendment): `uv export --format requirements-txt`
  // emits the Importer's hash-pinned requirements.txt from uv.lock, after which the
  // build is the identical pip-FOD pure/offline path. Carried as descriptor data so
  // dustcastle never reaches for uv2nix — uv is a front-end to one Importer.
  exportFrontEnd: uvExport,
  // The impurity signal reuses the slice-4 uv.lock reader (ADR 0004): a package
  // that ships an sdist but no wheels is sdist-only — impure — and routes to the
  // container path; wheel-bearing packages stay pure. uv.lock carries this
  // wheel-vs-sdist fact directly, unlike requirements.txt (whose static signal is
  // conservative-pure), so uv gets the richer reader.
  impuritySignal: {
    lockfile: "uv.lock",
    needsImpurity: (lockText) => uvLockNeedsImpurity(lockText),
  },
  // The impure in-container install (ADR 0004/0005): run uv's OWN export to produce
  // the hash-pinned requirements (derived from `uvExport`, so the command is
  // single-sourced — never a duplicated literal), then install them into ./site.
  impureInstall: [exportCommand(uvExport), PIP_INSTALL_INTO_SITE],
};

/**
 * poetry as a Python Package Manager (laimk-hse.7). Like uv, poetry is an EXPORT
 * FRONT-END to the SAME pip-FOD Importer, NOT poetry2nix — `poetry export`
 * produces the hash-pinned requirements (carried as `exportFrontEnd` data) that
 * feed the identical `generatePythonBuild` pip-FOD. `poetry.lock` is a real,
 * richer lockfile: it beats a co-present `requirements.txt`, and loses to `uv.lock`
 * (precedence uv.lock > poetry.lock > requirements.txt, ADR 0006d).
 *
 * The laimk-hse.7 spike PROVED `poetry export` hermetic against real poetry 2.4.1:
 * its `--require-hashes` output is `--only-binary=:all:`-clean (it emits a wheel
 * hash alongside each sdist hash, exactly as `uv export` does — harmless, since the
 * FOD downloads only the wheel and just needs its hash in the set) and feeds the
 * pip-FOD to the SAME aggregate hash as `uv export` for the same deps, building
 * pure/offline under nix-portable. So poetry carries NO `provisionGate` — like uv,
 * it provisions through the pure path. (The spike also corrected the export command
 * and the poetry.lock impurity reader for real poetry's 2.1 lock format.)
 */
// poetry's export front-end, named so both `exportFrontEnd` and `impureInstall`
// derive from ONE source (no duplicated export string).
const poetryExport: ExportFrontEnd = {
  command: "poetry",
  // Hashes are ON by default; no `--without-hashes` flag (it is a boolean opt-out,
  // and poetry-plugin-export 1.10 rejects the `=false` value form the laimk-hse.7
  // spike caught).
  args: ["export", "--format", "requirements.txt", "-o", "requirements.txt"],
  requirementsFile: "requirements.txt",
};

const poetry: PackageManagerDescriptor = {
  packageManager: "poetry",
  ecosystem: "python",
  // The Importer is the pip-FOD (same as pip/uv) — poetry only changes how the
  // hash-pinned requirements get PRODUCED (the export front-end below), not built.
  // poetry's real lockfile; it signals poetry, outranks requirements.txt, and is
  // outranked by uv.lock (ADR 0006d: uv.lock > poetry.lock > requirements.txt).
  lockfiles: ["poetry.lock"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
      // Build against the interpreter the resolver picked (laimk-hse.3); the pip-FOD
      // defaults to python312 only when detection found no version.
      ...(ctx.toolchainVersion !== undefined ? { interpreter: ctx.toolchainVersion } : {}),
    }),
  // The same single aggregate pip-FOD hash, landing in pythonDepsHash (not npmDepsHash).
  outputHashField: "pythonDepsHash",
  // The export front-end (ADR 0006 amendment): `poetry export` emits the Importer's
  // hash-pinned requirements.txt from poetry.lock. Hashes are ON by default — the
  // per-artifact hashes the pip-FOD's `--require-hashes` download needs — so no flag
  // is required (`--without-hashes` is a boolean OPT-OUT; poetry-plugin-export 1.10
  // rejects the `--without-hashes=false` value form the laimk-hse.7 spike caught).
  // Carried as descriptor data so dustcastle never reaches for poetry2nix — poetry
  // is a front-end to the one pip-FOD Importer.
  exportFrontEnd: poetryExport,
  // The impurity signal reuses the slice-4 poetry.lock reader (ADR 0004): a package
  // whose `[package.files]` lists only an sdist (no `.whl`) is sdist-only — impure —
  // and routes to the container path; wheel-bearing packages stay pure. poetry.lock
  // carries this wheel-vs-sdist fact directly, so poetry gets the richer reader.
  impuritySignal: {
    lockfile: "poetry.lock",
    needsImpurity: (lockText) => poetryLockNeedsImpurity(lockText),
  },
  // The impure in-container install (ADR 0004/0005): run poetry's OWN export
  // (derived from `poetryExport`, single-sourced) to produce the hash-pinned
  // requirements, then install them into ./site.
  impureInstall: [exportCommand(poetryExport), PIP_INSTALL_INTO_SITE],
  // No provisionGate: the laimk-hse.7 spike proved `poetry export` hermetic, so
  // poetry provisions through the same pure pip-FOD path as uv (the gate the
  // bun-gate honesty pattern reserved for an unproven front-end is no longer
  // warranted — see the docstring above).
};

// Keyed by Package Manager name for the Registry's compile-time exhaustiveness
// check (architecture review candidate 2). Insertion order = lockfile precedence.
export const PYTHON_MANAGERS = { uv, poetry, pip } satisfies Partial<
  Record<PackageManager, PackageManagerDescriptor>
>;

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
  // Pure staging (ADR 0002): the pip-FOD publishes its offline-assembled
  // site-packages under `$out/site`, copied into the worktree's `site` (PYTHONPATH
  // points there). The run env puts the python Toolchain (with pip) on PATH ahead
  // of the agent harness, reaches the staged site via PYTHONPATH, and points pip's
  // cache + home at /tmp since the Store is read-only.
  sandbox: {
    stageDir: "site",
    storeSubpath: "site",
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

/**
 * Decide whether a Python directory is a LOOSE manifest needing pin-then-pure (ADR
 * 0006c). A present `requirements.txt` is the pip-FOD's lockfile ONLY when it is
 * lock-grade (every requirement `==`-pinned and `--hash`-bearing); a present-but-
 * not-lock-grade file (unpinned, hash-less, or mixed) is loose. With no
 * requirements.txt, a RICHER lockfile (`uv.lock` / `poetry.lock`) is lock-grade —
 * its export front-end materialises the hash-pinned requirements.txt at provision
 * time (laimk-hse.6/.7), so the project is NOT loose. Only an abstract
 * pyproject.toml/setup.py with NO lock at all is loose — its declared deps have
 * nothing pinning them yet.
 */
function detectPythonLoose({ manifestPresent, hasLockfile, readFile }: LooseManifestInput): boolean {
  if (!manifestPresent) return false;
  const requirements = readFile("requirements.txt");
  if (requirements !== undefined) {
    // requirements.txt present: lock-grade builds pure directly; otherwise resolve.
    return !requirementsIsLockGrade(requirements);
  }
  // No requirements.txt: a uv.lock / poetry.lock is the lock (its export front-end
  // produces requirements.txt). Loose only when there is no lock at all.
  return !hasLockfile;
}
