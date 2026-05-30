import { generatePythonBuild } from "../nix/python.js";
import { poetryLockNeedsImpurity, requirementsNeedsImpurity, uvLockNeedsImpurity } from "../impurity/index.js";
import { requirementsIsLockGrade } from "./python-loose.js";
import {
  DEFAULT_PYTHON_INTERPRETERS,
  parsePythonVersionFile,
  readRequiresPython,
  resolvePythonInterpreter,
} from "./python-version.js";
import type { EcosystemDescriptor, LooseManifestInput, PackageManagerDescriptor } from "./types.js";

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
  // wheelhouse download + an offline `pip install --no-index` assembly.
  importer: "pip-FOD",
  // `requirements.txt` is consumed directly when hash-pinned (already lock-grade).
  lockfiles: ["requirements.txt"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
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
const uv: PackageManagerDescriptor = {
  packageManager: "uv",
  ecosystem: "python",
  // The Importer is the pip-FOD (same as pip) — uv only changes how the hash-pinned
  // requirements get PRODUCED (the export front-end below), never how they're built.
  importer: "pip-FOD",
  // uv's real lockfile; it signals uv and outranks requirements.txt (ADR 0006d).
  lockfiles: ["uv.lock"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  // The same single aggregate pip-FOD hash, landing in pythonDepsHash (not npmDepsHash).
  outputHashField: "pythonDepsHash",
  // The export front-end (ADR 0006 amendment): `uv export --format requirements-txt`
  // emits the Importer's hash-pinned requirements.txt from uv.lock, after which the
  // build is the identical pip-FOD pure/offline path. Carried as descriptor data so
  // dustcastle never reaches for uv2nix — uv is a front-end to one Importer.
  exportFrontEnd: {
    command: "uv",
    args: ["export", "--format", "requirements-txt", "-o", "requirements.txt"],
    requirementsFile: "requirements.txt",
  },
  // The impurity signal reuses the slice-4 uv.lock reader (ADR 0004): a package
  // that ships an sdist but no wheels is sdist-only — impure — and routes to the
  // container path; wheel-bearing packages stay pure. uv.lock carries this
  // wheel-vs-sdist fact directly, unlike requirements.txt (whose static signal is
  // conservative-pure), so uv gets the richer reader.
  impuritySignal: {
    lockfile: "uv.lock",
    needsImpurity: (lockText) => uvLockNeedsImpurity(lockText),
  },
};

/**
 * poetry as a Python Package Manager (laimk-hse.7). Like uv, poetry is an EXPORT
 * FRONT-END to the SAME pip-FOD Importer, NOT poetry2nix — `poetry export`
 * produces the hash-pinned requirements (carried as `exportFrontEnd` data) that
 * feed the identical `generatePythonBuild` pip-FOD. `poetry.lock` is a real,
 * richer lockfile: it beats a co-present `requirements.txt`, and loses to `uv.lock`
 * (precedence uv.lock > poetry.lock > requirements.txt, ADR 0006d).
 *
 * UNLIKE uv, poetry ALSO carries an honest `provisionGate` (ADR 0001: a gated
 * manager is a first-class Registry state, not an ad-hoc throw — the bun-gate
 * pattern). The spike (laimk-hse.1) validated the pip-FOD pure path end-to-end via
 * `uv export`, but did NOT prove `poetry export` hermetic — `poetry export` lives
 * in the separable `poetry-plugin-export`, resolves against poetry's own
 * environment, and its `--hash` output covers BOTH wheels and sdists rather than
 * the wheels-only, `--require-hashes`-clean shape the pip-FOD needs. Rather than
 * ship a build that might silently resolve from the network or fail the FOD,
 * detection still ROUTES poetry (so a poetry repo is recognised and surfaces an
 * actionable reason), but provisioning gates with that reason until `poetry export`
 * hermeticity is proven (then the gate is simply dropped, as for uv). All the
 * descriptor data — the export front-end, the impurity reader, the pip-FOD build —
 * is wired and unit-tested, so lifting the gate is a one-line change, not a rewrite.
 */
const poetry: PackageManagerDescriptor = {
  packageManager: "poetry",
  ecosystem: "python",
  // The Importer is the pip-FOD (same as pip/uv) — poetry only changes how the
  // hash-pinned requirements get PRODUCED (the export front-end below), not built.
  importer: "pip-FOD",
  // poetry's real lockfile; it signals poetry, outranks requirements.txt, and is
  // outranked by uv.lock (ADR 0006d: uv.lock > poetry.lock > requirements.txt).
  lockfiles: ["poetry.lock"],
  generateBuild: (ctx) =>
    generatePythonBuild({
      pname: ctx.pname,
      pythonDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  // The same single aggregate pip-FOD hash, landing in pythonDepsHash (not npmDepsHash).
  outputHashField: "pythonDepsHash",
  // The export front-end (ADR 0006 amendment): `poetry export` emits the Importer's
  // hash-pinned requirements.txt from poetry.lock. `--without-hashes=false` keeps
  // the per-artifact hashes (poetry's flag is opt-OUT, so we explicitly opt in) the
  // pip-FOD's `--require-hashes` download needs. Carried as descriptor data so
  // dustcastle never reaches for poetry2nix — poetry is a front-end to one Importer.
  // (Behind the provisionGate below until export hermeticity is proven.)
  exportFrontEnd: {
    command: "poetry",
    args: ["export", "--format", "requirements.txt", "--without-hashes=false", "-o", "requirements.txt"],
    requirementsFile: "requirements.txt",
  },
  // The impurity signal reuses the slice-4 poetry.lock reader (ADR 0004): a package
  // whose `[package.files]` lists only an sdist (no `.whl`) is sdist-only — impure —
  // and routes to the container path; wheel-bearing packages stay pure. poetry.lock
  // carries this wheel-vs-sdist fact directly, so poetry gets the richer reader.
  impuritySignal: {
    lockfile: "poetry.lock",
    needsImpurity: (lockText) => poetryLockNeedsImpurity(lockText),
  },
  // The honest provision gate (ADR 0001, the bun-gate pattern). `poetry export`
  // hermeticity is UNPROVEN by the spike (only `uv export` was validated), so
  // provisioning surfaces this actionable reason rather than shipping a build that
  // might resolve from the network or hand the pip-FOD a wheel+sdist requirements
  // file. Detection still routes poetry; lifting this gate (once export is proven
  // hermetic) is dropping this one field — the rest of the descriptor is ready.
  provisionGate: {
    reason:
      "dustcastle: poetry is detected, but provisioning is gated — `poetry export`'s " +
      "hermeticity is not yet proven (the spike validated only `uv export`). poetry " +
      "export resolves against poetry's own environment and emits hashes for sdists as " +
      "well as wheels, which the wheels-only `--require-hashes` pip-FOD cannot assume. " +
      "Pin a hash-pinned, wheels-only requirements.txt (or `uv export` from a uv.lock) " +
      "to build pure today; poetry's export front-end ships once it is proven hermetic.",
  },
};

export const PYTHON_MANAGERS: readonly PackageManagerDescriptor[] = [uv, poetry, pip];

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
};

/**
 * Decide whether a Python directory is a LOOSE manifest needing pin-then-pure (ADR
 * 0006c). A present `requirements.txt` is the pip-FOD's lockfile ONLY when it is
 * lock-grade (every requirement `==`-pinned and `--hash`-bearing); a present-but-
 * not-lock-grade file (unpinned, hash-less, or mixed) is loose. With no
 * requirements.txt at all, an abstract pyproject.toml/setup.py (no lock) is loose
 * too — its declared deps have nothing pinning them yet.
 */
function detectPythonLoose({ manifestPresent, readFile }: LooseManifestInput): boolean {
  if (!manifestPresent) return false;
  const requirements = readFile("requirements.txt");
  if (requirements !== undefined) {
    // requirements.txt present: lock-grade builds pure directly; otherwise resolve.
    return !requirementsIsLockGrade(requirements);
  }
  // No requirements.txt: an abstract pyproject/setup.py with no lock is loose.
  return true;
}
