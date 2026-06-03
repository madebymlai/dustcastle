import type { Logger, LogFields } from "../log/index.js";
import type { SweptLogEvent } from "../log/format.js";
import type { PreparedRun } from "../run/index.js";

/** The agent harness the sandbox runs: coding-agent runner, model, and mounted login. */
export interface AgentPosture {
  readonly runner: string;
  readonly model: string;
  readonly mount: string;
}

export interface LogPostureOptions {
  readonly note?: string;
  readonly agent?: AgentPosture;
}

export interface PreparedPosture {
  readonly provisioned: Pick<PreparedRun["provisioned"], "mode">;
  readonly ecosystems: readonly PreparedPostureEcosystem[];
}

interface PreparedPostureEcosystem {
  readonly detection: Pick<PreparedRun["ecosystems"][number]["detection"], "ecosystem" | "toolchainVersion">;
  readonly provisioned: Pick<PreparedRun["ecosystems"][number]["provisioned"], "toolchainStorePath">;
}

/**
 * Surface the provisioned posture as ordinary log lines (ADR 0014, revised): one
 * fact per line, each carrying only what isn't already on the console from the
 * operational logs. The old single `🏖️` banner event duplicated the play-by-play
 * — most visibly the egress allowlist, which `proxy enforcing allowlist` already
 * prints — so egress is omitted here. The store mode and per-toolchain store paths
 * ARE unique (the deep `toolchain built` log is debug-level), as is the agent
 * harness; those become their own lines. The full structured detail still lands in
 * the JSON flight recorder via these same records.
 */
export function logPosture(logger: Logger, prepared: PreparedPosture, opts: LogPostureOptions = {}): void {
  logger.info({ mode: prepared.provisioned.mode }, "store provisioned (rootless nix-portable)");
  for (const ecosystem of prepared.ecosystems) {
    logger.info(toolchainFields(ecosystem), `${ecosystem.detection.ecosystem} toolchain ready`);
  }
  if (opts.agent !== undefined) {
    logger.info({ ...opts.agent }, "agent ready");
  }
  if (opts.note !== undefined) {
    logger.info(opts.note);
  }
}

export function logSweep(logger: Logger, line: string): void {
  logger.info(sweptEvent(line), "swept");
}

export function sweptEvent(line: string): SweptLogEvent & LogFields {
  const parsed = parseSweepLine(line);
  return {
    event: "swept",
    line,
    ...(parsed !== undefined ? parsed : {}),
  };
}

/** The unique per-toolchain facts a posture line carries: the resolved version and Store path. */
function toolchainFields(ecosystem: PreparedPostureEcosystem): LogFields {
  return {
    ...(ecosystem.detection.toolchainVersion !== undefined ? { version: ecosystem.detection.toolchainVersion } : {}),
    storePath: ecosystem.provisioned.toolchainStorePath,
  };
}

const SWEEP_LINE_PATTERN = /^(\d+) last sweep freed (\d+) bytes \((\d+) path\(s\) collected\)$/;

function parseSweepLine(line: string): Pick<SweptLogEvent, "sweptAt" | "freedBytes" | "pathsCollected"> | undefined {
  const match = SWEEP_LINE_PATTERN.exec(line);
  if (match === null) return undefined;

  const [, sweptAt, freedBytes, pathsCollected] = match;
  return {
    sweptAt: Number(sweptAt),
    freedBytes: Number(freedBytes),
    pathsCollected: Number(pathsCollected),
  };
}
