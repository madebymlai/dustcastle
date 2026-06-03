import { spawn, type SpawnOptions } from "node:child_process";
import type { Logger } from "../log/index.js";
import { noopLogger } from "../log/index.js";

export interface StreamingRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type StreamingLogLevel = "info" | "debug";

export interface RunStreamingOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  /** Human command label used in structured stream log messages. */
  readonly label: string;
  /** Decide which stderr lines are user-visible progress and which are debug detail. */
  readonly classifyStderrLine?: (line: string) => StreamingLogLevel;
}

function defaultStderrLineClassifier(): StreamingLogLevel {
  return "debug";
}

/**
 * Run a child process asynchronously, streaming stderr lines to the logger as they
 * arrive while retaining full stdout/stderr for callers that need parsing or error
 * tails. The child is resolved on `close`, after any trailing partial stderr line is
 * flushed through the same curation seam.
 */
export function runStreamingAsync(
  command: string,
  args: readonly string[],
  opts: RunStreamingOptions,
): Promise<StreamingRunResult> {
  const logger = opts.logger ?? noopLogger;
  const classifyStderrLine = opts.classifyStderrLine ?? defaultStderrLineClassifier;
  const spawnOptions: SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  const child = spawn(command, [...args], spawnOptions);
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    throw new Error("runStreamingAsync expected piped stdout/stderr streams");
  }
  stdoutStream.setEncoding("utf8");
  stderrStream.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  let pendingStderrLine = "";

  const emitStderrLine = (line: string): void => {
    if (line.length === 0) return;
    const level = classifyStderrLine(line);
    logger[level]({ line }, `${opts.label} stderr`);
  };

  stdoutStream.on("data", (chunk: string) => {
    stdout += chunk;
  });

  stderrStream.on("data", (chunk: string) => {
    stderr += chunk;
    pendingStderrLine += chunk;
    const lines = pendingStderrLine.split("\n");
    pendingStderrLine = lines.pop() ?? "";
    for (const line of lines) emitStderrLine(line);
  });

  return new Promise((resolve) => {
    child.on("error", (err) => {
      const line = err.message;
      stderr += line;
      emitStderrLine(line);
    });

    child.on("close", (status) => {
      if (pendingStderrLine.length > 0) {
        emitStderrLine(pendingStderrLine);
        pendingStderrLine = "";
      }
      resolve({ status, stdout, stderr });
    });
  });
}
