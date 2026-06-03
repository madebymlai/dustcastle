import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "./index.js";

const RUN_LOG_DIR = "runs";
const STDERR_LOG_SETTINGS = ["debug", "info", "silent"] as const;

export type StderrLogSetting = (typeof STDERR_LOG_SETTINGS)[number];
export type TargetLevel = "trace" | StderrLogSetting;

export interface LoggerTransportTarget extends pino.TransportTargetOptions<Record<string, unknown>> {
  readonly target: string;
  readonly level: TargetLevel;
  readonly options: Record<string, unknown>;
}

export interface LoggerTransportSpec extends pino.TransportMultiOptions<Record<string, unknown>> {
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
  mkdirSync(runLogDirectory(opts.homeDir), { recursive: true });
  return pino(
    { level: config.level, base: null },
    pino.transport(config.transport),
  ) as Logger;
}

export function loggerConfig(opts: CreateLoggerOptions): LoggerConfig {
  const runLogPath = runLogFilePath(opts.homeDir, opts.now ?? new Date());
  const stderrLevel = stderrLogSetting(opts.env?.DUSTCASTLE_LOG);
  return {
    level: "trace",
    runLogPath,
    transport: {
      targets: [
        {
          // Stock pino-pretty straight off the package — no custom renderer: the
          // [time] LEVEL header, the bare message, and expanded fields.
          target: "pino-pretty",
          level: stderrLevel,
          options: {
            destination: 2,
            // `colorize` is intentionally OMITTED so pino-pretty auto-detects the TTY —
            // color when a human watches live, plain text when stderr is redirected/
            // captured (the AFK case), so captured logs carry no ANSI noise. `mod`
            // (internal module taxonomy), the operational `event` discriminator, and the
            // swept-sweep numbers are hidden so a user never reads dustcastle's
            // implementation detail off the console — all stay in the flight recorder.
            ignore: "mod,event,sweptAt,freedBytes,pathsCollected,line,stream,cmd",
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
  if (isStderrLogSetting(value)) return value;
  throw new Error(`DUSTCASTLE_LOG must be one of ${STDERR_LOG_SETTINGS.join(", ")}`);
}

function isStderrLogSetting(value: string): value is StderrLogSetting {
  return (STDERR_LOG_SETTINGS as readonly string[]).includes(value);
}

function runLogDirectory(homeDir: string): string {
  return join(homeDir, RUN_LOG_DIR);
}

function runLogFilePath(homeDir: string, date: Date): string {
  return join(runLogDirectory(homeDir), `${timestampName(date)}.jsonl`);
}

function timestampName(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
