import { spawnSync } from "node:child_process";

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
 * `node_modules` or downloading/running scripts. npm and pnpm both expose a
 * first-class lockfile-only resolve; yarn classic does not, so it (and anything
 * unknown) is gated honestly rather than built wrong (the bun-gate pattern).
 */
export function lockOnlyResolve(packageManager: string): ResolveCommand {
  switch (packageManager) {
    case "npm":
      return { command: "npm", args: ["install", "--package-lock-only"], lockfile: "package-lock.json" };
    case "pnpm":
      return { command: "pnpm", args: ["install", "--lockfile-only"], lockfile: "pnpm-lock.yaml" };
    case "yarn":
      throw new Error(
        "pin-then-pure: yarn has no clean lockfile-only resolve — commit a yarn.lock, or use " +
          "npm/pnpm, to build pure (ADR 0006c). dustcastle won't run a full yarn install just to pin.",
      );
    default:
      throw new Error(
        `pin-then-pure: cannot resolve a loose manifest for ${packageManager} — no lockfile-only ` +
          "resolve is supported (npm and pnpm are; ADR 0006c). Commit a lockfile to build pure.",
      );
  }
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

function defaultResolve(command: string, args: readonly string[], cwd: string): ResolveResult {
  const r = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  const stderr = r.stderr ?? (r.error instanceof Error ? r.error.message : "");
  return { status: r.status, stderr };
}
