import pretty from "pino-pretty";

export interface ProvisionedToolchainLog {
  readonly ecosystem: string;
  readonly version?: string;
  readonly storePath: string;
}

export type ProvisionedEgressLog =
  | { readonly kind: "none" }
  | {
      readonly kind: "allowlist";
      readonly buildHosts: readonly string[];
      readonly agentHosts: readonly string[];
    };

export interface ProvisionedAgentLog {
  readonly runner: string;
  readonly model: string;
  readonly mount: string;
}

export interface ProvisionedLogEvent {
  readonly event: "provisioned";
  readonly ecosystems: readonly string[];
  readonly mode: string;
  readonly egress: ProvisionedEgressLog;
  readonly toolchains: readonly ProvisionedToolchainLog[];
  readonly note?: string;
  readonly agent?: ProvisionedAgentLog;
}

export interface SweptLogEvent {
  readonly event: "swept";
  readonly line: string;
  readonly sweptAt?: number;
  readonly freedBytes?: number;
  readonly pathsCollected?: number;
}

export type MessageFormatLog = Record<string, unknown>;

export function messageFormat(log: MessageFormatLog): string {
  if (isProvisionedEvent(log)) return provisionedMessage(log);
  if (isSweptEvent(log)) return sweptMessage(log);
  return ordinaryMessage(log);
}

export default function prettyTransport(opts: Record<string, unknown>) {
  return pretty({ ...opts, messageFormat });
}

function provisionedMessage(log: ProvisionedLogEvent): string {
  const lines = [
    `🏖️  dustcastle: provisioned ${log.ecosystems.join(" + ")}`,
    `    store mode : ${log.mode}  (rootless nix-portable)`,
    ...log.toolchains.map(
      (toolchain) =>
        `    ${toolchain.ecosystem.padEnd(7)}: ${toolchain.version ?? "(default)"}  ${toolchain.storePath}`,
    ),
    "    deps       : installed in-Sandbox (ADR 0012)",
    `    egress     : ${egressMessage(log.egress)}`,
    "    /nix/store mounted read-only into the sandbox",
  ];
  if (log.note !== undefined) lines.push(`    ${log.note}`);
  if (log.agent !== undefined) {
    lines.push(`    agent      : ${log.agent.runner} @ ${log.agent.model}  (${log.agent.mount} mounted)`);
  }
  return lines.join("\n");
}

function sweptMessage(log: SweptLogEvent): string {
  return `🧹 dustcastle: ${log.line}`;
}

function ordinaryMessage(log: MessageFormatLog): string {
  const msg = stringValue(log.msg);
  const mod = stringValue(log.mod);
  if (mod !== undefined && msg !== undefined) return `${mod}: ${msg}`;
  if (msg !== undefined) return msg;
  if (mod !== undefined) return `${mod}:`;
  return "";
}

function egressMessage(egress: ProvisionedEgressLog): string {
  if (egress.kind === "none") return "closed (no network)";
  const build = egress.buildHosts.length > 0 ? `[${egress.buildHosts.join(", ")}]` : "(offline)";
  const agent = egress.agentHosts.length > 0 ? `[${egress.agentHosts.join(", ")}]` : "(none)";
  return `allowlist — build: ${build}  agent: ${agent}`;
}

function isProvisionedEvent(log: MessageFormatLog): log is ProvisionedLogEvent & MessageFormatLog {
  return (
    log.event === "provisioned" &&
    isStringArray(log.ecosystems) &&
    typeof log.mode === "string" &&
    isEgress(log.egress) &&
    Array.isArray(log.toolchains) &&
    log.toolchains.every(isToolchain) &&
    (log.note === undefined || typeof log.note === "string") &&
    (log.agent === undefined || isAgent(log.agent))
  );
}

function isSweptEvent(log: MessageFormatLog): log is SweptLogEvent & MessageFormatLog {
  return log.event === "swept" && typeof log.line === "string";
}

function isToolchain(value: unknown): value is ProvisionedToolchainLog {
  if (!isRecord(value)) return false;
  return (
    typeof value.ecosystem === "string" &&
    (value.version === undefined || typeof value.version === "string") &&
    typeof value.storePath === "string"
  );
}

function isEgress(value: unknown): value is ProvisionedEgressLog {
  if (!isRecord(value)) return false;
  if (value.kind === "none") return true;
  return value.kind === "allowlist" && isStringArray(value.buildHosts) && isStringArray(value.agentHosts);
}

function isAgent(value: unknown): value is ProvisionedAgentLog {
  if (!isRecord(value)) return false;
  return typeof value.runner === "string" && typeof value.model === "string" && typeof value.mount === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
