import pretty from "pino-pretty";

export interface SweptLogEvent {
  readonly event: "swept";
  readonly line: string;
  readonly sweptAt?: number;
  readonly freedBytes?: number;
  readonly pathsCollected?: number;
}

export type MessageFormatLog = Record<string, unknown>;

export function messageFormat(log: MessageFormatLog): string {
  if (isSweptEvent(log)) return sweptMessage(log);
  return ordinaryMessage(log);
}

export default function prettyTransport(opts: Record<string, unknown>): ReturnType<typeof pretty> {
  return pretty({ ...opts, messageFormat });
}

function sweptMessage(log: SweptLogEvent): string {
  return `🧹 dustcastle: ${log.line}`;
}

function ordinaryMessage(log: MessageFormatLog): string {
  // The message only — `mod` is dustcastle's internal module taxonomy
  // (egress/store/orchestrate/gc), an implementation detail a watching user should
  // not have to decode. It stays in the JSON flight recorder, not on the console.
  return stringValue(log.msg) ?? "";
}

function isSweptEvent(log: MessageFormatLog): log is SweptLogEvent & MessageFormatLog {
  return log.event === "swept" && typeof log.line === "string";
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
