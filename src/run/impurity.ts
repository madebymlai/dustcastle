import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Detection } from "../detect/index.js";
import { packageManagerDescriptor } from "../ecosystems/index.js";
import {
  decideImpurity,
  impurityMarkerJson,
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

  // The lockfile that carries the install-script signal, and how to read it, are
  // owned by the manager's Registry descriptor (ADR 0006 — the lockfile names the
  // manager). Every node manager has an impuritySignal (yarn/bun's is always-false
  // by design, ADR 0004), so the lookup is total here.
  const { impuritySignal } = packageManagerDescriptor(detection.packageManager);
  const lockPath = join(cwd, impuritySignal!.lockfile);
  const impurityNeeded = impuritySignal!.needsImpurity(readTextSafe(lockPath));
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
