import type { Logger, LogFields } from "../log/index.js";
import type { ProvisionedAgentLog, ProvisionedLogEvent, ProvisionedToolchainLog, SweptLogEvent } from "../log/format.js";
import type { PreparedRun } from "../run/index.js";

export interface LogPostureOptions {
  readonly note?: string;
  readonly agent?: ProvisionedAgentLog;
}

export interface PreparedPosture {
  readonly provisioned: Pick<PreparedRun["provisioned"], "mode">;
  readonly ecosystems: readonly PreparedPostureEcosystem[];
  readonly plan: Pick<PreparedRun["plan"], "egress">;
}

interface PreparedPostureEcosystem {
  readonly detection: Pick<PreparedRun["ecosystems"][number]["detection"], "ecosystem" | "toolchainVersion">;
  readonly provisioned: Pick<PreparedRun["ecosystems"][number]["provisioned"], "toolchainStorePath">;
}

export function logPosture(logger: Logger, prepared: PreparedPosture, opts: LogPostureOptions = {}): void {
  logger.info(provisionedEvent(prepared, opts), "provisioned");
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

export function provisionedEvent(prepared: PreparedPosture, opts: LogPostureOptions = {}): ProvisionedLogEvent & LogFields {
  return {
    event: "provisioned",
    ecosystems: prepared.ecosystems.map((ecosystem) => ecosystem.detection.ecosystem),
    mode: prepared.provisioned.mode,
    egress: prepared.plan.egress,
    toolchains: prepared.ecosystems.map(toolchainEvent),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
  };
}

function toolchainEvent(ecosystem: PreparedPostureEcosystem): ProvisionedToolchainLog {
  return {
    ecosystem: ecosystem.detection.ecosystem,
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
