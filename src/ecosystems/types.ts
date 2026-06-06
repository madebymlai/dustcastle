/**
 * The Ecosystem Registry's type vocabulary (ADR 0001 — internal curation, NOT a
 * plugin system). These are the two closed, vetted unions the whole epic derives
 * from, plus the two descriptor grains (CONTEXT.md):
 *
 *   - an {@link EcosystemDescriptor} owns the DETECTION grain — how an Ecosystem
 *     recognises itself in a directory, resolves which Package Manager a repo
 *     uses, and reads its Toolchain version (ADR 0006a/b/d);
 *   - a {@link PackageManagerDescriptor} owns the DISPATCH grain — the Toolchain
 *     Nix expression, the in-Sandbox install command, and the registry host
 *     (ADR 0006a, ADR 0012).
 *
 * The `Detection` type lives here too — it is the Registry's output shape — and
 * is re-exported from `src/detect/index.ts` so existing import paths keep working.
 */

/** A language world dustcastle can provision (CONTEXT.md glossary: Ecosystem). */
export type Ecosystem = "node" | "go" | "python" | "rust";

/**
 * The specific tool within an Ecosystem that owns a repo's dependency resolution
 * (CONTEXT.md: Package Manager). A closed union — the lockfile names one of these,
 * which selects its install command. Go is still a Package Manager, not a special case.
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "go" | "pip" | "uv" | "poetry" | "cargo";

/**
 * What detection concludes about one directory: which Ecosystem it is and the
 * package manager that signalled it (ADR 0006 — the lockfile names the manager,
 * which selects the install command + registry host).
 */
export interface Detection {
  readonly ecosystem: Ecosystem;
  /**
   * The closed Package Manager union, not a free string (laimk-mhg.6): detection
   * VALIDATES the resolved manager against the Registry at the single lockfile→
   * manager narrowing point as it builds the Detection, so every downstream
   * dispatch site (store/sandbox/run) is exhaustive by construction — a half-added
   * Ecosystem fails at tsc, not at a runtime `default:`/Registry-miss.
   */
  readonly packageManager: PackageManager;
  /**
   * The runtime version the repo asks for, read from version files / manifests
   * (ADR 0006b). The lockfile names the manager but not the toolchain version;
   * for Go that comes from go.mod's `go` line. Undefined when unspecified.
   */
  readonly toolchainVersion?: string;
  /**
   * A resolvable-but-unpinned manifest: a `package.json` with no lockfile (ADR
   * 0006c). dustcastle's in-Sandbox install resolves it (ADR 0012); detection still
   * surfaces the flag for callers. Undefined/false when a lockfile pins it.
   */
  readonly loose?: boolean;
}

/**
 * The inputs a Toolchain Nix expression needs (ADR 0001/0012). dustcastle realizes
 * ONLY the Toolchain into the Store now — Project Deps install in-Sandbox via the
 * sandcastle hook (ADR 0012, always-impure), so there is no deps FOD and no
 * fixed-output deps hash here. Each descriptor adapts the resolved version as its
 * semantics require.
 */
export interface ToolchainContext {
  /** Derivation name (typically the repo directory name). */
  readonly pname: string;
  /**
   * The detected Package Manager (ADR 0012). Threaded so a generator can ship the
   * in-Sandbox install's own tooling in the Toolchain — Python's `uv`/`poetry` export
   * front-ends run in-Sandbox now, so a uv repo's Toolchain must carry `uv` (poetry →
   * `poetry`), while pip needs neither. Node/Go/Rust have a single manager and ignore it.
   */
  readonly packageManager?: PackageManager;
  /**
   * The resolved Toolchain version (ADR 0006b), threaded from `Detection`. Each
   * generator adapts it as its semantics require — Python reads it as the nixpkgs
   * interpreter attr (`python311`) the Toolchain is built from; Node/Go/Rust
   * currently hardcode their runtime and ignore it. Undefined when detection
   * found no version.
   */
  readonly toolchainVersion?: string;
}

/** A buildable Toolchain Nix expression plus the single attribute the store realizes. */
export interface ToolchainBuild {
  /** The Nix expression (a `default.nix` body) that emits the Toolchain derivation. */
  readonly expression: string;
  /** The attribute the store realizes via `nix-build -A <attr>` (CONTEXT.md: Toolchain). */
  readonly attr: string;
}

/**
 * The DISPATCH grain (CONTEXT.md: Package Manager). Everything the store and the
 * in-Sandbox install key on for one Package Manager — owned in one place rather
 * than smeared across per-manager switches at each site.
 */
export interface PackageManagerDescriptor {
  /** The closed Package Manager name this descriptor keys on. */
  readonly packageManager: PackageManager;
  /** The Ecosystem this manager belongs to. */
  readonly ecosystem: Ecosystem;
  /**
   * The lockfile name(s) that signal this manager, in precedence order. A manager
   * usually has one; bun has two (`bun.lockb`, `bun.lock`).
   *
   * The Toolchain Nix expression is NOT a parallel string label: it's emitted by
   * {@link generateToolchain} (the function that owns the expression), so it never
   * needed a duplicate field keyed alongside (architecture review candidate 2).
   */
  readonly lockfiles: readonly string[];
  /**
   * Emit the Toolchain's Nix expression (ADR 0001/0012). dustcastle realizes ONLY
   * the Toolchain into the Store now — Project Deps install in-Sandbox via the
   * sandcastle hook, so there is no deps FOD. Uniform across managers.
   */
  readonly generateToolchain: (ctx: ToolchainContext) => ToolchainBuild;
  /**
   * The canonical in-Sandbox install command(s) (CONTEXT.md: Install command; ADR
   * 0012, always-impure). The real Package Manager runs in-Sandbox via the sandcastle
   * hook — lifecycle/postinstall scripts included. ONE resolving install line per
   * manager (`npm install`, `pnpm install`, `go mod download`, `cargo fetch`, `pip
   * install -r requirements.txt`): it installs from a committed lockfile when one is
   * present and resolves when one is not, so a loose/lockless repo still installs.
   * We deliberately avoid the frozen variants (`npm ci`, `--frozen-lockfile`,
   * `--require-hashes`) — they hard-fail without a lockfile, which is exactly the
   * common loose case, and the byte-reproducibility they buy is out of scope (ADR
   * 0012). go/cargo already had this shape; node/python converged onto it. Its
   * assembled output is what the deps cache stores (only for lock-grade repos — a
   * loose resolves are cached by ADR 0016's manifest/lockfile fingerprint). uv/poetry
   * prepend their own `export` step before the shared pip install.
   *
   * REQUIRED on EVERY descriptor (go/cargo included): there is no pure-vs-impure
   * decision any more, so every detected manager installs in-Sandbox — proven at
   * `tsc`, not by a runtime biconditional against a deleted impurity signal.
   */
  readonly installCommand: readonly string[];
}

/**
 * The in-Sandbox staging facet (ADR 0002/0012): the things that vary per Ecosystem
 * when running a provisioned project in the Sandbox — the stage dir its in-Sandbox
 * install lands in, AND the run environment the container runs under. `setupFor`
 * and `mergeEnv` (src/sandbox/plan.ts) consume these — the knowledge of WHERE deps
 * land and WHICH env to run under lives here on the descriptor, not in per-Ecosystem
 * `if` ladders.
 */
export interface SandboxStaging {
  /**
   * The worktree directory deps are installed into (`node_modules` for node, `site`
   * for python, `vendor` for go). The run env points the toolchain here
   * (PYTHONPATH=site, node_modules by convention), and it is git-excluded so the
   * in-Sandbox install never churns the agent's diff.
   */
  readonly stageDir: string;
  /**
   * The run environment for this Ecosystem given the Toolchain `bin` directory:
   * the Toolchain on PATH (the project's node/go/python/rust wins, ahead of the
   * agent harness in /usr/local/bin) plus the writable cache vars that must point
   * off the read-only Store (node's NPM_CONFIG_CACHE/XDG_CACHE_HOME, python's
   * PYTHONPATH/PIP_CACHE_DIR, go's GOFLAGS/GOPROXY/GOCACHE/etc.). `envFor`
   * (src/sandbox/plan.ts) resolves this per Ecosystem.
   */
  readonly env: (bin: string) => Record<string, string>;
}

/** The inputs an Ecosystem's toolchain-version reader threads (ADR 0006b). */
export interface ToolchainVersionInput {
  /** The Ecosystem's manifest text (package.json / go.mod), if present. */
  readonly manifest: string | undefined;
  /** Read an idiomatic version file's trimmed content (`.nvmrc`, `.node-version`). */
  readonly readVersionFile: (name: string) => string | undefined;
}

/** The inputs an Ecosystem's loose-manifest reader threads (ADR 0006c). */
export interface LooseManifestInput {
  /** Whether a manifest marker file is present in the directory. */
  readonly manifestPresent: boolean;
  /** Whether a lockfile naming one of the Ecosystem's managers is present. */
  readonly hasLockfile: boolean;
  /** Read a repo file's text by name (`requirements.txt`, `pyproject.toml`). */
  readonly readFile: (name: string) => string | undefined;
}

/**
 * The DETECTION grain (CONTEXT.md: Ecosystem). How an Ecosystem recognises itself
 * in a directory, resolves which of its Package Managers a repo uses, and reads
 * its Toolchain version (ADR 0006a/b/d).
 */
export interface EcosystemDescriptor {
  readonly ecosystem: Ecosystem;
  /** The manifest marker file(s) that say "this directory is this Ecosystem". */
  readonly manifests: readonly string[];
  /**
   * The Package Managers, in lockfile-precedence order (ADR 0006d): the ordering
   * IS the precedence — among lockfiles a richer manager beats `package-lock.json`.
   */
  readonly managers: readonly PackageManager[];
  /** The fallback manager when no lockfile/declaration pins one (npm for node). */
  readonly defaultManager: PackageManager;
  /**
   * Resolve the explicitly-declared manager (node's `packageManager` field; ADR
   * 0006d explicit > inferred). Absent for Ecosystems with a single manager (go).
   */
  readonly readDeclaredManager?: (manifest: string | undefined) => PackageManager | undefined;
  /** Read the requested Toolchain version (ADR 0006b). Absent when none applies. */
  readonly readToolchainVersion?: (input: ToolchainVersionInput) => string | undefined;
  /**
   * Decide whether a directory is a LOOSE manifest — a resolvable-but-unpinned
   * manifest with no lockfile (ADR 0006c). Absent for Ecosystems whose "manifest
   * present but no lockfile" IS the loose test (Node's package.json) — the generic
   * default covers them. Present for Python, where `requirements.txt` is BOTH the
   * manifest AND the lockfile, so loose-ness is a CONTENT decision (unpinned/hash-less
   * requirements.txt, or an abstract pyproject with no lock), not a file-presence one.
   */
  readonly isLooseManifest?: (input: LooseManifestInput) => boolean;
  /**
   * The in-Sandbox Project-Deps staging (ADR 0002/0012): which worktree dir the
   * in-Sandbox install lands in, plus the run env. Consumed by `setupFor`/`mergeEnv`
   * (src/sandbox/plan.ts).
   */
  readonly sandbox: SandboxStaging;
}
