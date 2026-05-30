import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Detection } from "../detect/index.js";
import {
  decideImpurity,
  impurityMarkerJson,
  npmLockNeedsImpurity,
  pnpmLockNeedsImpurity,
  type ImpurityDecision,
  type ImpurityMarker,
  type ImpurityMode,
} from "../impurity/index.js";
import { parseGitRemoteHost } from "../sandbox/egress.js";

/** The project-local, version-controlled impurity marker (ADR 0004). */
const MARKER_PATH = join(".dustcastle", "impure.json");

export interface ResolveImpurityInput {
  readonly cwd: string;
  readonly detection: Detection;
  readonly mode: ImpurityMode;
  readonly headless: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The run-layer glue for the impurity policy (ADR 0004): figure out whether the
 * project needs an impure build (read from its lockfile), then run the pure
 * decision machine. Only Node has impure install scripts in v1; everything else
 * is always pure.
 */
export function resolveImpurity(input: ResolveImpurityInput): ImpurityDecision {
  const { cwd, detection } = input;
  if (detection.ecosystem !== "node") return { kind: "pure" };

  const lockPath = join(cwd, lockfileName(detection.packageManager));
  const impurityNeeded = lockNeedsImpurity(detection.packageManager, lockPath);
  const lockfileHash = hashFileOr(lockPath, detection.packageManager);
  const priorConsent = readPriorConsent(cwd, lockfileHash);

  return decideImpurity({
    mode: input.mode,
    impurityNeeded,
    headless: input.headless,
    ecosystem: detection.ecosystem,
    packageManager: detection.packageManager,
    lockfileHash,
    headlessFallback: input.env.DUSTCASTLE_IMPURE_HEADLESS === "allow" ? "allow" : "deny",
    ...(priorConsent !== undefined ? { priorConsent } : {}),
  });
}

/** A human y/n is pending: the question to ask and the consent to record (ADR 0004). */
export interface InteractiveAsk {
  /** Identifies the exact deps state this consent applies to. */
  readonly lockfileHash: string;
  /** The marker to persist on a "yes" — doubles as the cached consent record. */
  readonly marker: ImpurityMarker;
  /** The human-facing question for the TTY. */
  readonly prompt: string;
}

/**
 * The interactive half of the impurity policy (ADR 0004), kept pure so it stays
 * unit-tested: resolve the decision as if a human were present (`headless:false`)
 * and, when it lands on `ask`, return the question + the consent to record. Any
 * terminal decision (pure / impure / deny / cached consent) yields `undefined` —
 * there is nothing to prompt. The CLI does the actual TTY I/O.
 */
export function pendingImpurityAsk(
  input: Omit<ResolveImpurityInput, "headless">,
): InteractiveAsk | undefined {
  const decision = resolveImpurity({ ...input, headless: false });
  if (decision.kind !== "ask") return undefined;
  const { detection } = input;
  return {
    lockfileHash: decision.lockfileHash,
    marker: {
      ecosystem: detection.ecosystem,
      packageManager: detection.packageManager,
      lockfileHash: decision.lockfileHash,
    },
    prompt:
      `dustcastle: ${detection.packageManager} deps need an impure build (a dependency reaches ` +
      `the network at install time). Allow it? A tracked marker will record consent. [y/N] `,
  };
}

/** Parse a y/n answer — only an explicit yes counts; everything else is no (the safe default). */
export function parseYesNo(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** Write the visible marker (async consent), creating `.dustcastle/` as needed. */
export function writeImpurityMarker(cwd: string, marker: ImpurityMarker): void {
  const path = join(cwd, MARKER_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, impurityMarkerJson(marker));
}

/**
 * Whether the project already consented to an impure build for this exact deps
 * state — the `ask`-mode cache (ADR 0004: "once per project, cached by lockfile
 * hash"). The marker doubles as the consent record.
 */
function readPriorConsent(cwd: string, lockfileHash: string): boolean | undefined {
  const marker = readJsonSafe(join(cwd, MARKER_PATH)) as { lockfileHash?: unknown } | undefined;
  if (marker === undefined || typeof marker.lockfileHash !== "string") return undefined;
  return marker.lockfileHash === lockfileHash ? true : undefined;
}

/** Read the repo's git remote host (origin) for the egress allowlist (ADR 0005). */
export function gitRemoteHost(cwd: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseGitRemoteHost(result.stdout.trim());
}

/** The lockfile that carries a manager's install-script signal (ADR 0006 names the manager). */
function lockfileName(packageManager: string): string {
  switch (packageManager) {
    case "pnpm":
      return "pnpm-lock.yaml";
    case "yarn":
      return "yarn.lock";
    case "bun":
      return "bun.lock";
    default:
      return "package-lock.json"; // npm
  }
}

/**
 * Whether the manager's lockfile signals an impure build (ADR 0004), read straight
 * from the lockfile per manager rather than inferred from a failed build. npm
 * records `hasInstallScript`; pnpm records `requiresBuild: true`.
 *
 * yarn.lock (v1) carries NO install-script metadata — yarn's build policy lives in
 * `package.json#dependenciesMeta.built` / `.yarnrc`, not the lockfile — so a yarn
 * project always resolves pure. That's the safe default, not a gap: the pure
 * `yarnConfigHook` provision never runs untrusted scripts, so faking a signal the
 * lockfile can't carry would be worse than honest (the bun-gate honesty pattern).
 * bun is gated at provision; there is nothing to detect here either.
 */
function lockNeedsImpurity(packageManager: string, lockPath: string): boolean {
  switch (packageManager) {
    case "pnpm":
      return pnpmLockNeedsImpurity(readTextSafe(lockPath));
    case "yarn":
    case "bun":
      return false;
    default:
      return npmLockNeedsImpurity(readJsonSafe(lockPath)); // npm
  }
}

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** SHA-256 of the lockfile content, or a stable fallback keyed by manager. */
function hashFileOr(path: string, fallbackKey: string): string {
  try {
    return `sha256-${createHash("sha256").update(readFileSync(path)).digest("base64")}`;
  } catch {
    return `nolock-${fallbackKey}`;
  }
}

export { MARKER_PATH };
