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
  /**
   * Decide which output lines are user-visible progress (info) and which are debug
   * detail. Applied to BOTH stdout and stderr: build tools split progress across the
   * two inconsistently (podman writes its STEP lines to stdout, nix-build to stderr),
   * so the classifier keys off line CONTENT, not which stream it arrived on.
   */
  readonly classifyLine?: (line: string) => StreamingLogLevel;
}

function defaultLineClassifier(): StreamingLogLevel {
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
  const classifyLine = opts.classifyLine ?? defaultLineClassifier;
  const spawnOptions: SpawnOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  const child = spawn(command, args, spawnOptions);
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  if (stdoutStream === null || stderrStream === null) {
    throw new Error("runStreamingAsync expected piped stdout/stderr streams");
  }
  stdoutStream.setEncoding("utf8");
  stderrStream.setEncoding("utf8");

  let stdout = "";
  let stderr = "";

  const emitLine = (line: string, stream: "stdout" | "stderr"): void => {
    if (line.length === 0) return;
    logger[classifyLine(line)]({ line }, `${opts.label} ${stream}`);
  };

  // Line-buffer one stream: emit each complete line live as it arrives, and return a
  // `flush` for the trailing partial line at close. Both stdout and stderr stream
  // through this — progress can land on either (see classifyLine).
  const lineBuffer = (stream: "stdout" | "stderr") => {
    let pending = "";
    return {
      push: (chunk: string) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) emitLine(line, stream);
      },
      flush: () => {
        if (pending.length > 0) {
          emitLine(pending, stream);
          pending = "";
        }
      },
    };
  };

  const outBuffer = lineBuffer("stdout");
  const errBuffer = lineBuffer("stderr");

  stdoutStream.on("data", (chunk: string) => {
    stdout += chunk;
    outBuffer.push(chunk);
  });

  stderrStream.on("data", (chunk: string) => {
    stderr += chunk;
    errBuffer.push(chunk);
  });

  return new Promise((resolve) => {
    child.on("error", (err) => {
      const line = err.message;
      stderr += line;
      emitLine(line, "stderr");
    });

    child.on("close", (status) => {
      outBuffer.flush();
      errBuffer.flush();
      resolve({ status, stdout, stderr });
    });
  });
}
