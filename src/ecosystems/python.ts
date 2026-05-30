import { generatePythonBuild } from "../nix/python.js";
import { requirementsNeedsImpurity } from "../impurity/index.js";
import {
  DEFAULT_PYTHON_INTERPRETERS,
  parsePythonVersionFile,
  readRequiresPython,
  resolvePythonInterpreter,
} from "./python-version.js";
import type { EcosystemDescriptor, PackageManagerDescriptor } from "./types.js";

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
  // No lockOnlyResolve yet (loose-manifest pin-then-pure is laimk-hse.5). A
  // hash-pinned requirements.txt is already lock-grade and builds pure.
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
};
