import type { NixBuild } from "../nix/go.js";

/**
 * The Ecosystem Registry's type vocabulary (ADR 0001 — internal curation, NOT a
 * plugin system). These are the two closed, vetted unions the whole epic derives
 * from, plus the two descriptor grains (CONTEXT.md):
 *
 *   - an {@link EcosystemDescriptor} owns the DETECTION grain — how an Ecosystem
 *     recognises itself in a directory, resolves which Package Manager a repo
 *     uses, and reads its Toolchain version (ADR 0006a/b/d);
 *   - a {@link PackageManagerDescriptor} owns the DISPATCH grain — store
 *     provisioning (the Importer + output-hash field), the impurity signal, and
 *     the pin-then-pure resolve (ADR 0004/0006a/c).
 *
 * The `Detection` type lives here too — it is the Registry's output shape — and
 * is re-exported from `src/detect/index.ts` so existing import paths keep working.
 */

/** A language world dustcastle can provision (CONTEXT.md glossary: Ecosystem). */
export type Ecosystem = "node" | "go" | "python";

/**
 * The specific tool within an Ecosystem that owns a repo's dependency resolution
 * (CONTEXT.md: Package Manager). A closed union — the lockfile names one of these,
 * which selects the Importer. Go is still a Package Manager, not a special case.
 */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "go" | "pip" | "uv" | "poetry";

/**
 * What detection concludes about one directory: which Ecosystem it is, the
 * package manager that signalled it, and therefore the Nix importer to run
 * (ADR 0006 — the lockfile names the manager, which selects the importer).
 */
export interface Detection {
  readonly ecosystem: Ecosystem;
  /**
   * The closed Package Manager union, not a free string (laimk-mhg.6): detection
   * VALIDATES the resolved manager against the Registry at the single lockfile→
   * manager narrowing point as it builds the Detection, so every downstream
   * dispatch site (store/impurity/pin/sandbox/run) is exhaustive by construction —
   * a half-added Ecosystem fails at tsc, not at a runtime `default:`/Registry-miss.
   */
  readonly packageManager: PackageManager;
  /**
   * The runtime version the repo asks for, read from version files / manifests
   * (ADR 0006b). The lockfile names the importer but not the toolchain version;
   * for Go that comes from go.mod's `go` line. Undefined when unspecified.
   */
  readonly toolchainVersion?: string;
  /**
   * A resolvable-but-unpinned manifest: a `package.json` with no lockfile (ADR
   * 0006c). dustcastle resolves it once into a generated lock, then builds pure —
   * strictly better than going impure. Undefined/false when a lockfile pins it.
   */
  readonly loose?: boolean;
}

/**
 * The uniform inputs every Importer needs to emit its expression. The store
 * passes the discovered/supplied deps hash and the staged `src` path; each
 * descriptor adapts these onto its generator's spec (Go reads it as `vendorHash`,
 * npm as `npmDepsHash`, pnpm/yarn/pip as `depsHash`) so the dispatch site stays
 * uniform (CONTEXT.md: the Importer is a property of the Package Manager).
 */
export interface BuildContext {
  /** Derivation name (typically the repo directory name). */
  readonly pname: string;
  /** The fixed-output hash pinning the deps FOD (ADR 0004). */
  readonly depsHash: string;
  /** The Nix `src` path the build runs against (the store stages source here). */
  readonly src?: string;
  /**
   * The resolved Toolchain version (ADR 0006b), threaded from `Detection`. Each
   * generator adapts it as its semantics require — Python reads it as the nixpkgs
   * interpreter attr (`python311`) the pip-FOD builds against; Node/Go currently
   * hardcode their runtime and ignore it. Undefined when detection found no version.
   */
  readonly toolchainVersion?: string;
}

/**
 * The lockfile-read impurity signal (ADR 0004), read straight from the lockfile
 * per manager rather than inferred from a failed build. Present for every JS
 * manager; `needsImpurity` reads true for npm/pnpm when the lockfile records a
 * script flag, and is always-false for yarn/bun (settled by design — their
 * lockfiles can't carry the flag, so faking one would be worse than honest).
 */
export interface ImpuritySignal {
  /** The lockfile that carries (or can't carry) the install-script signal. */
  readonly lockfile: string;
  /** Read the manager's lockfile text and decide whether an impure build is needed. */
  readonly needsImpurity: (lockText: string | undefined) => boolean;
}

/**
 * The pin-then-pure lock-only resolve state (ADR 0006c). Either a runnable
 * `command` that produces a lockfile WITHOUT installing node_modules, or a
 * `gated` state carrying its actionable reason (yarn classic has no clean
 * lockfile-only resolve — the bun-gate honesty pattern). Absent when the manager
 * never needs pinning (bun is gated at provision; go has a real lockfile).
 */
export type LockOnlyResolve =
  | {
      readonly kind: "command";
      readonly command: string;
      readonly args: readonly string[];
      /** The lockfile this resolve generates — the visible, committed artifact. */
      readonly lockfile: string;
    }
  | { readonly kind: "gated"; readonly reason: string };

/**
 * A first-class, honest gate on a Package Manager (ADR 0001: a gated manager is a
 * Registry state, not an ad-hoc throw). bun carries one because nixpkgs has no
 * canonical bun deps importer yet — detection still routes bun, but provisioning
 * surfaces this reason rather than building it wrong.
 */
export interface ProvisionGate {
  readonly reason: string;
}

/**
 * The export FRONT-END a Package Manager runs to produce the pip-FOD's input — a
 * hash-pinned `requirements.txt` — from its own lockfile (ADR 0006 amendment). uv
 * carries `uv export --format requirements-txt` and poetry carries `poetry export`
 * (laimk-hse.7); the EXPORTED requirements then feed the SAME pip-FOD Importer, so
 * each is a front-end to that one Importer, NOT a separate importer / uv2nix /
 * poetry2nix. Absent for a manager that consumes its lockfile directly (pip reads
 * `requirements.txt` as-is).
 */
export interface ExportFrontEnd {
  /** The front-end binary to run (`uv`). */
  readonly command: string;
  /** Its args, emitting the hash-pinned requirements file (`export --format requirements-txt …`). */
  readonly args: readonly string[];
  /** The requirements file the export writes — the visible artifact the pip-FOD consumes. */
  readonly requirementsFile: string;
}

/**
 * The DISPATCH grain (CONTEXT.md: Package Manager). Everything the store, impurity
 * policy, and pin step key on for one Package Manager — owned in one place rather
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
   * The Nix Importer itself is NOT a field: it's emitted by {@link generateBuild}
   * (the function that owns the expression), so it never needed a duplicate string
   * label keyed in parallel (architecture review candidate 2).
   */
  readonly lockfiles: readonly string[];
  /** Emit the Importer's Nix expression for a deps hash (ADR 0004). Uniform across managers. */
  readonly generateBuild: (ctx: BuildContext) => NixBuild;
  // (deprecated — Provisioned now uses a single `depsHash` field; no per-manager dispatch needed.)
  /** The lockfile-read impurity signal (ADR 0004). Absent for go (no impure install scripts). */
  readonly impuritySignal?: ImpuritySignal;
  /** The pin-then-pure lock-only resolve (ADR 0006c). Absent for gated/already-locked managers. */
  readonly lockOnlyResolve?: LockOnlyResolve;
  /**
   * The export front-end that produces the Importer's hash-pinned requirements from
   * this manager's own lockfile (ADR 0006 amendment). Present for uv (`uv export`);
   * absent for pip, which consumes `requirements.txt` directly.
   */
  readonly exportFrontEnd?: ExportFrontEnd;
  /**
   * The frozen/immutable in-container install command(s) for the impure path
   * (ADR 0004/0005). When deps were NOT pre-assembled in the Store, the real
   * install — lifecycle/postinstall scripts included — runs in the container under
   * scoped egress, with the manager that signalled. Each command installs strictly
   * from the committed/exported requirements (frozen lockfile, `--require-hashes`),
   * so an impure build still can't silently drift from the pinned deps.
   *
   * PRESENT for every manager that can reach the impure path — i.e. exactly those
   * with an {@link impuritySignal} (npm/pnpm/yarn/bun + pip/uv/poetry). ABSENT for
   * go, which has no `impuritySignal` and builds pure unconditionally. That biconditional
   * (`impureInstall` iff `impuritySignal`) is the invariant `ecosystems.test.ts` pins —
   * the field is legitimately optional, so the guarantee is a test, not the type system.
   */
  readonly impureInstall?: readonly string[];
  /** The honest provision gate (ADR 0001). Present only for bun in v1. */
  readonly provisionGate?: ProvisionGate;
}

/**
 * The PURE-path sandbox staging facet (ADR 0002): the things that vary per
 * Ecosystem when running a provisioned project in the Sandbox — copying Project
 * Deps out of the read-only Store into the writable worktree, AND the run
 * environment the container runs under. `stageCommands` and `envFor`
 * (src/sandbox/plan.ts) consume these — the knowledge of WHAT to stage and WHICH
 * env to run under lives here on the descriptor, not in per-Ecosystem `if` ladders.
 */
export interface SandboxStaging {
  /**
   * The worktree directory deps are staged into (`node_modules` for node, `site`
   * for python, `vendor` for go). The run env points the toolchain here
   * (PYTHONPATH=site, GOFLAGS=-mod=vendor, node_modules by convention).
   */
  readonly stageDir: string;
  /**
   * The path WITHIN `depsStorePath` to copy from. node's deps FOD publishes
   * `node_modules`, python's pip-FOD publishes `site`; go's deps store path IS
   * the vendor dir, so it has no subpath — `stageCommands` copies the whole
   * `depsStorePath`. Empty string means "copy the store path itself".
   */
  readonly storeSubpath: string;
  /**
   * The run environment for this Ecosystem given the Toolchain `bin` directory:
   * the Toolchain on PATH (the project's node/go/python wins, ahead of the
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
   * Decide whether a directory is a LOOSE manifest needing pin-then-pure (ADR
   * 0006c). Absent for Ecosystems whose "manifest present but no lockfile" IS the
   * loose test (Node's package.json) — the generic default covers them. Present
   * for Python, where `requirements.txt` is BOTH the manifest AND the lockfile, so
   * loose-ness is a CONTENT decision (unpinned/hash-less requirements.txt, or an
   * abstract pyproject with no lock), not a file-presence one.
   */
  readonly isLooseManifest?: (input: LooseManifestInput) => boolean;
  /**
   * The PURE-path Project-Deps staging (ADR 0002): which worktree dir deps are
   * staged into and which subpath of the deps Store to copy from. Consumed by
   * `stageCommands` (src/sandbox/plan.ts) to emit the self-healing copy.
   */
  readonly sandbox: SandboxStaging;
}
