import type { Logger, LogFields } from "../log/index.js";
import type { ProvisionedAgentLog, ProvisionedLogEvent, ProvisionedToolchainLog, SweptLogEvent } from "../log/format.js";
import type { PreparedRun } from "../run/index.js";

export interface LogPostureOptions {
  readonly note?: string;
  readonly agent?: ProvisionedAgentLog;
}

export function logPosture(logger: Logger, prepared: PreparedRun, opts: LogPostureOptions = {}): void {
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

export function provisionedEvent(prepared: PreparedRun, opts: LogPostureOptions = {}): ProvisionedLogEvent & LogFields {
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

function toolchainEvent(ecosystem: PreparedRun["ecosystems"][number]): ProvisionedToolchainLog {
  return {
    ecosystem: ecosystem.detection.ecosystem,
    ...(ecosystem.detection.toolchainVersion !== undefined ? { version: ecosystem.detection.toolchainVersion } : {}),
    storePath: ecosystem.provisioned.toolchainStorePath,
  };
}

function parseSweepLine(line: string): Pick<SweptLogEvent, "sweptAt" | "freedBytes" | "pathsCollected"> | undefined {
  const match = /^(\d+) last sweep freed (\d+) bytes \((\d+) path\(s\) collected\)$/.exec(line);
  if (match === null) return undefined;
  return {
    sweptAt: Number(match[1]),
    freedBytes: Number(match[2]),
    pathsCollected: Number(match[3]),
  };
}
