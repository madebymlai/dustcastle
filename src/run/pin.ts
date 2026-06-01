import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_MANAGERS, packageManagerDescriptor } from "../ecosystems/index.js";
import type { PackageManager } from "../ecosystems/index.js";

/**
 * Pin-then-pure (ADR 0006c). A loose manifest — a `package.json` with no
 * lockfile — is resolvable-but-unpinned: it can't be fetched offline. Rather than
 * go impure (ADR 0004), dustcastle resolves it ONCE into a generated, committed
 * lockfile (a one-time online resolve, a visible artifact), then every build runs
 * pure/offline against that lock. This module holds the pure resolve-command
 * decision + the imperative resolve runner (injected in tests).
 */

/** The lock-only resolve invocation for a package manager (pure). */
export interface ResolveCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** The lockfile this resolve generates — the visible, committed artifact. */
  readonly lockfile: string;
}

/**
 * The manager-specific lock-only resolve: produce the lockfile WITHOUT installing
 * `node_modules` or downloading/running scripts. The decision is now DERIVED from
 * the Registry's per-manager `lockOnlyResolve` state (ADR 0001/0006c) rather than
 * a per-manager switch here: npm and pnpm carry a runnable `command`; yarn classic
 * carries a `gated` state with its actionable reason (no clean lockfile-only
 * resolve — the bun-gate honesty pattern); a manager with no `lockOnlyResolve`
 * (bun, go — gated at provision or already locked) and anything unknown falls back
 * to the generic loose-manifest error.
 */
export function lockOnlyResolve(packageManager: string): ResolveCommand {
  const resolve = isPackageManager(packageManager)
    ? packageManagerDescriptor(packageManager).lockOnlyResolve
    : undefined;
  if (resolve?.kind === "command") {
    return { command: resolve.command, args: resolve.args, lockfile: resolve.lockfile };
  }
  if (resolve?.kind === "gated") {
    throw new Error(resolve.reason);
  }
  throw new Error(
    `pin-then-pure: cannot resolve a loose manifest for ${packageManager} — no lockfile-only ` +
      "resolve is supported for this manager (ADR 0006c). Commit a lockfile to build pure.",
  );
}

const PACKAGE_MANAGER_SET = new Set<string>(PACKAGE_MANAGERS);
function isPackageManager(name: string): name is PackageManager {
  return PACKAGE_MANAGER_SET.has(name);
}

/** The minimal result of a resolve invocation the orchestration reasons about. */
export interface ResolveResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs the lock-only resolve in a directory. Injected in tests; defaults to a real spawn. */
export type ResolveRunner = (command: string, args: readonly string[], cwd: string) => ResolveResult;

export interface PinOptions {
  /** The loose-manifest project directory to resolve in place. */
  readonly cwd: string;
  /** The package manager detection chose (selects the resolve invocation). */
  readonly packageManager: string;
  /** Inject a resolve runner (tests); defaults to a real spawn. */
  readonly run?: ResolveRunner;
  /** Surface progress (never silent — ADR 0006c: the generated lock is visible). */
  readonly onLine?: (line: string) => void;
}

/** What the pin step produced: the generated, committed lockfile (surfaced). */
export interface Pinned {
  readonly lockfile: string;
}

/**
 * Resolve a loose manifest once into a committed lockfile, in place. The
 * one-time online resolve (ADR 0006c). Throws an actionable error if the resolve
 * fails, so a half-pinned project never proceeds to a (broken) pure build.
 */
export function pinLooseManifest(opts: PinOptions): Pinned {
  const resolve = lockOnlyResolve(opts.packageManager);
  const run = opts.run ?? defaultResolve;
  opts.onLine?.(`pin-then-pure: resolving loose manifest → ${resolve.lockfile} (${resolve.command})`);

  const result = run(resolve.command, resolve.args, opts.cwd);
  if (result.status !== 0) {
    throw new Error(
      `pin-then-pure: lock-only resolve failed (exit ${result.status}) for ${opts.packageManager}:\n` +
        result.stderr.slice(-2000),
    );
  }
  opts.onLine?.(`pin-then-pure: generated ${resolve.lockfile} (commit it — a visible, reproducible artifact)`);
  return { lockfile: resolve.lockfile };
}

/** What the export front-end produced: the hash-pinned requirements file (surfaced). */
export interface Exported {
  readonly requirementsFile: string;
}

export interface ExportOptions {
  /** The project directory to materialise the requirements file in. */
  readonly cwd: string;
  /** The package manager detection chose (selects the export front-end). */
  readonly packageManager: string;
  /** Inject a runner (tests); defaults to a real spawn. */
  readonly run?: ResolveRunner;
  /** Surface progress (never silent — the generated requirements file is visible). */
  readonly onLine?: (line: string) => void;
}

/**
 * Run a manager's EXPORT FRONT-END (ADR 0006 amendment) to materialise the pip-FOD's
 * hash-pinned `requirements.txt` from its OWN lockfile, in place, BEFORE provisioning.
 * uv carries `uv export --format requirements-txt` and poetry `poetry export`
 * (laimk-hse.7); pip consumes `requirements.txt` directly, and a still-gated manager
 * (e.g. bun) throws at provision — so this returns `undefined` and the run pipeline
 * skips it. Throws an actionable error if the export fails, so a project never
 * proceeds to a build whose requirements were never produced.
 */
export function exportRequirements(opts: ExportOptions): Exported | undefined {
  if (!isPackageManager(opts.packageManager)) return undefined;
  const descriptor = packageManagerDescriptor(opts.packageManager);
  // A still-gated manager throws at provision; don't bother running its export.
  if (descriptor.provisionGate !== undefined) return undefined;
  const frontEnd = descriptor.exportFrontEnd;
  if (frontEnd === undefined) return undefined;

  const run = opts.run ?? defaultResolve;
  opts.onLine?.(`export: producing ${frontEnd.requirementsFile} from the lockfile (${frontEnd.command})`);
  const result = run(frontEnd.command, frontEnd.args, opts.cwd);
  if (result.status !== 0) {
    throw new Error(
      `export: ${opts.packageManager} front-end failed (exit ${result.status}) producing ` +
        `${frontEnd.requirementsFile}:\n${result.stderr.slice(-2000)}`,
    );
  }
  opts.onLine?.(`export: generated ${frontEnd.requirementsFile} (the pip-FOD input)`);
  return { requirementsFile: frontEnd.requirementsFile };
}

function defaultResolve(command: string, args: readonly string[], cwd: string): ResolveResult {
  // `cargo generate-lockfile` writes the sparse index cache under CARGO_HOME. Give
  // it an isolated writable home (and do not set --offline); the generated
  // Cargo.lock is the only artifact dustcastle keeps before the pure vendor path.
  const cargoHome = command === "cargo" && args[0] === "generate-lockfile"
    ? mkdtempSync(join(tmpdir(), "dustcastle-cargo-home-"))
    : undefined;
  try {
    const env = cargoHome === undefined ? process.env : { ...process.env, CARGO_HOME: cargoHome };
    const r = spawnSync(command, [...args], { cwd, encoding: "utf8", env });
    const stderr = r.stderr ?? (r.error instanceof Error ? r.error.message : "");
    return { status: r.status, stderr };
  } finally {
    if (cargoHome !== undefined) rmSync(cargoHome, { recursive: true, force: true });
  }
}
