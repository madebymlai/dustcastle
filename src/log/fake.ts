import type { LogFields, Logger, LogMethod } from "./index.js";

export type MemoryLogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

export interface MemoryLogRecord {
  readonly level: MemoryLogLevel;
  readonly fields: LogFields;
  readonly msg?: string;
  readonly args: readonly unknown[];
}

export interface MemoryLogger extends Logger {
  readonly records: MemoryLogRecord[];
}

export function createMemoryLogger(bindings: LogFields = {}, records: MemoryLogRecord[] = []): MemoryLogger {
  const emit = (level: MemoryLogLevel): LogMethod => {
    return ((first?: string | LogFields, second?: string, ...args: unknown[]) => {
      if (typeof first === "string") {
        records.push({ level, fields: { ...bindings }, msg: first, args: [second, ...args].filter((v) => v !== undefined) });
        return;
      }
      records.push({
        level,
        fields: { ...bindings, ...(isFields(first) ? first : {}) },
        ...(typeof second === "string" ? { msg: second } : {}),
        args,
      });
    }) as LogMethod;
  };

  const logger: MemoryLogger = {
    records,
    fatal: emit("fatal"),
    error: emit("error"),
    warn: emit("warn"),
    info: emit("info"),
    debug: emit("debug"),
    trace: emit("trace"),
    child: (childBindings) => createMemoryLogger({ ...bindings, ...childBindings }, records),
  };
  return logger;
}

function isFields(value: unknown): value is LogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
