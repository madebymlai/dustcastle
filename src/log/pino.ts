import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "./index.js";

export type StderrLogSetting = "debug" | "info" | "silent";
export type TargetLevel = "trace" | StderrLogSetting;

export interface LoggerTransportTarget {
  readonly target: "pino-pretty" | "pino/file";
  readonly level: TargetLevel;
  readonly options: Record<string, unknown>;
}

export interface LoggerTransportSpec {
  readonly targets: readonly LoggerTransportTarget[];
}

export interface LoggerConfig {
  readonly level: "trace";
  readonly runLogPath: string;
  readonly transport: LoggerTransportSpec;
}

export interface CreateLoggerOptions {
  readonly homeDir: string;
  readonly env?: { readonly DUSTCASTLE_LOG?: string };
  readonly now?: Date;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const config = loggerConfig(opts);
  mkdirSync(join(opts.homeDir, "runs"), { recursive: true });
  return pino(
    { level: config.level, base: null },
    pino.transport(config.transport as Parameters<typeof pino.transport>[0]),
  ) as Logger;
}

export function loggerConfig(opts: CreateLoggerOptions): LoggerConfig {
  const runLogPath = join(opts.homeDir, "runs", `${timestampName(opts.now ?? new Date())}.jsonl`);
  const stderrLevel = stderrLogSetting(opts.env?.DUSTCASTLE_LOG);
  return {
    level: "trace",
    runLogPath,
    transport: {
      targets: [
        {
          target: "pino-pretty",
          level: stderrLevel,
          options: {
            destination: 2,
            colorize: false,
            translateTime: "SYS:standard",
          },
        },
        {
          target: "pino/file",
          level: "trace",
          options: { destination: runLogPath, mkdir: true },
        },
      ],
    },
  };
}

export function stderrLogSetting(value: string | undefined): StderrLogSetting {
  if (value === undefined || value === "") return "info";
  if (value === "debug" || value === "info" || value === "silent") return value;
  throw new Error("DUSTCASTLE_LOG must be one of debug, info, silent");
}

function timestampName(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
