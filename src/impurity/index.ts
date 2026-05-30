import type { Ecosystem } from "../detect/index.js";

// The Python impurity-signal readers (laimk-hse.4) live in a standalone, pure
// module and are re-exported here alongside the npm/pnpm readers so every
// lockfile→needsImpurity reader is discoverable from one barrel.
export { poetryLockNeedsImpurity, requirementsNeedsImpurity, uvLockNeedsImpurity } from "./python.js";

/**
 * The impurity policy (ADR 0004). A project's deps are Nix-built pure/offline by
 * default; when a dep genuinely can't build hermetically (a `postinstall` that
 * hits the network, a native module), this policy governs what happens.
 *
 * The invariant is NOT "always pure" but "you always know whether a Sandbox is
 * reproducible" — impurity is permitted, but never *silent*.
 */
export type ImpurityMode = "allow" | "ask" | "deny";

const MODES: readonly ImpurityMode[] = ["allow", "ask", "deny"];

/**
 * Source the impurity mode from the environment (ADR 0005 — dustcastle is
 * config-less; the explicit channel is env, never a committed config file).
 * Defaults to `allow`, the solo / own-repos flow ([ADR 0005] makes it safe).
 */
export function parseImpurityMode(env: NodeJS.ProcessEnv): ImpurityMode {
  const raw = env.DUSTCASTLE_IMPURE;
  if (raw === undefined || raw.trim() === "") return "allow";
  const mode = raw.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(mode)) return mode as ImpurityMode;
  throw new Error(
    `dustcastle: invalid DUSTCASTLE_IMPURE=${JSON.stringify(raw)} — expected one of ${MODES.join(", ")}.`,
  );
}

/** The visible, version-controlled record that an impure build happened (ADR 0004). */
export interface ImpurityMarker {
  readonly ecosystem: Ecosystem | string;
  readonly packageManager: string;
  /** Identifies the exact deps state this consent/record applies to. */
  readonly lockfileHash: string;
}

/** Everything the pure state machine needs to decide. No I/O, no clock. */
export interface ImpurityContext {
  readonly mode: ImpurityMode;
  /** Whether the pure/offline build cannot satisfy the deps (impurity is needed). */
  readonly impurityNeeded: boolean;
  /** No interactive human present (CI / unattended agent). */
  readonly headless: boolean;
  readonly ecosystem: Ecosystem | string;
  readonly packageManager: string;
  readonly lockfileHash: string;
  /**
   * A cached answer for this lockfile hash in `ask` mode (ADR 0004: "once per
   * project, then cached by lockfile hash"). Undefined when not yet answered.
   */
  readonly priorConsent?: boolean;
  /**
   * What `ask` falls back to when headless — a blocking prompt must never stall
   * an unattended agent (ADR 0004). Defaults to `deny` (preserve the gate).
   */
  readonly headlessFallback?: "allow" | "deny";
}

/**
 * The outcome of the policy. `ask` is the only non-terminal kind: the caller
 * prompts the human, records consent keyed by `lockfileHash`, and re-decides.
 */
export type ImpurityDecision =
  | { readonly kind: "pure" }
  | { readonly kind: "impure"; readonly marker: ImpurityMarker }
  | { readonly kind: "ask"; readonly lockfileHash: string }
  | { readonly kind: "deny"; readonly reason: string };

/**
 * Decide what to do about impurity (ADR 0004). Pure and total — every input maps
 * to a terminal decision except interactive `ask`, which defers to the caller.
 */
export function decideImpurity(ctx: ImpurityContext): ImpurityDecision {
  // The common path: a clean lockfile builds offline. The policy never fires —
  // mode is irrelevant when purity already holds.
  if (!ctx.impurityNeeded) return { kind: "pure" };

  const marker: ImpurityMarker = {
    ecosystem: ctx.ecosystem,
    packageManager: ctx.packageManager,
    lockfileHash: ctx.lockfileHash,
  };

  switch (ctx.mode) {
    case "allow":
      // Build impurely, recording a visible marker — asynchronous consent.
      return { kind: "impure", marker };

    case "deny":
      return { kind: "deny", reason: denyReason(ctx) };

    case "ask": {
      if (ctx.priorConsent === true) return { kind: "impure", marker };
      if (ctx.priorConsent === false) {
        return { kind: "deny", reason: `${denyReason(ctx)} (previously declined for this lockfile)` };
      }
      // No cached answer. Headless can't prompt → fall back decisively.
      if (ctx.headless) {
        return (ctx.headlessFallback ?? "deny") === "allow"
          ? { kind: "impure", marker }
          : { kind: "deny", reason: `${denyReason(ctx)} (headless: no human to confirm)` };
      }
      return { kind: "ask", lockfileHash: ctx.lockfileHash };
    }
  }
}

function denyReason(ctx: ImpurityContext): string {
  return (
    `dustcastle: ${ctx.packageManager} deps require an impure build (a dependency reaches the ` +
    `network at install time), but impurity is denied. Set DUSTCASTLE_IMPURE=allow to build ` +
    `impurely (a tracked marker records it), or DUSTCASTLE_IMPURE=ask to be prompted.`
  );
}

/**
 * Decide whether an npm lockfile needs an impure build (ADR 0004), read straight
 * from the lockfile rather than inferred from a failed build. npm's lockfile
 * (v2/v3) records `hasInstallScript: true` on any package with an `install`/
 * `preinstall`/`postinstall` script — exactly the deps the pure, `--ignore-
 * scripts` provision build cannot satisfy. Conservative: anything unparseable is
 * treated as pure (no scripts to run), and impurity only ever *adds* gating.
 */
export function npmLockNeedsImpurity(lock: unknown): boolean {
  if (typeof lock !== "object" || lock === null) return false;
  const packages = (lock as { packages?: unknown }).packages;
  if (typeof packages !== "object" || packages === null) return false;
  return Object.values(packages as Record<string, unknown>).some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { hasInstallScript?: unknown }).hasInstallScript === true,
  );
}

/**
 * Decide whether a pnpm lockfile needs an impure build (ADR 0004), the pnpm
 * analogue of `npmLockNeedsImpurity`. pnpm-lock.yaml has no `hasInstallScript`;
 * its equivalent is `requiresBuild: true` on a package's metadata entry — pnpm
 * marks any dependency with install/postinstall scripts (or a native build) that
 * way, which is exactly what the pure, `--ignore-scripts` provision can't satisfy.
 * The lockfile is YAML and ADR 0001 forbids a heavyweight parser, so we scan it as
 * text (mirroring the owned pnpm-workspace.yaml parser in detect/workspace.ts).
 * Conservative: anything non-string or without the flag is treated as pure.
 */
export function pnpmLockNeedsImpurity(lock: unknown): boolean {
  if (typeof lock !== "string") return false;
  // `requiresBuild` is a pnpm-reserved package-metadata key; the indentation anchor
  // keeps it a nested YAML key (never a stray match). Impurity only ever adds gating.
  return lock.split("\n").some((line) => /^\s+requiresBuild:\s*true\s*$/.test(line));
}

/**
 * Serialize the marker for the project's version-controlled record. Stable key
 * order so the file produces a clean, reviewable diff (ADR 0004).
 */
export function impurityMarkerJson(marker: ImpurityMarker): string {
  return `${JSON.stringify(
    {
      ecosystem: marker.ecosystem,
      packageManager: marker.packageManager,
      lockfileHash: marker.lockfileHash,
    },
    null,
    2,
  )}\n`;
}
