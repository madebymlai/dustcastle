import { generatePythonToolchain } from "./toolchain-nix.js";
import { requirementsIsLockGrade } from "./python-loose.js";
import {
  DEFAULT_PYTHON_INTERPRETERS,
  parsePythonVersionFile,
  readRequiresPython,
  resolvePythonInterpreter,
} from "./python-version.js";
import type {
  EcosystemDescriptor,
  LooseManifestInput,
  PackageManager,
  PackageManagerDescriptor,
} from "./types.js";

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
