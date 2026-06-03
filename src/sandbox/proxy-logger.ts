import pino from "pino";
import type { Logger } from "../log/index.js";

/** The egress proxy runs in a separate container: raw JSON to stderr, no run file. */
export function createProxyLogger(): Logger {
  return pino(proxyLoggerOptions(), pino.destination(2)) as Logger;
}

export function proxyLoggerOptions(): pino.LoggerOptions {
  return { level: "trace", base: null };
}
