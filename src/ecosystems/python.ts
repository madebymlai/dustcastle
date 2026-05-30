import { generatePythonBuild } from "../nix/python.js";
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
  // No impuritySignal yet (sdist-only routing is a later slice — laimk-hse.4) and
  // no lockOnlyResolve yet (loose-manifest pin-then-pure is laimk-hse.5). A
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
  // No declared-manager resolver and no toolchain-version reader yet: those are
  // later slices (the .python-version + requires-python resolver is laimk-hse.3).
};
