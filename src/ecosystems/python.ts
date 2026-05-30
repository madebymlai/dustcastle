import { generatePythonBuild } from "../nix/python.js";
import { requirementsNeedsImpurity } from "../impurity/index.js";
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
 * This tracer slice wires ONE Package Manager (`pip`) consuming a hash-pinned,
 * wheels-only `requirements.txt` directly. uv and poetry are export FRONT-ENDS to
 * this same Importer (later slices), loose-manifest pin-then-pure (`uv pip compile
 * --generate-hashes`), the impurity/sdist routing, and toolchain-version resolution
 * are deliberately out of this slice (later children of laimk-hse). They extend
 * this file; this slice does not stub them with wrong behaviour.
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

export const PYTHON_MANAGERS: readonly PackageManagerDescriptor[] = [pip];

export const PYTHON_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "python",
  // The manifest markers that say "this directory is Python" (ADR 0006a).
  manifests: ["pyproject.toml", "requirements.txt", "setup.py"],
  // A single Package Manager in this tracer slice (uv/poetry are later children).
  managers: ["pip"],
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
