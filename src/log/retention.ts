import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { noopLogger, type Logger } from "./index.js";

export const FLIGHT_RECORDER_CEILING_BYTES = 2 ** 24;

export interface RunLogEntry {
  readonly path: string;
  readonly bytes: number;
  readonly createdAtMs: number;
}

export interface PruneRunLogsReport {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly bytesFreed: number;
  readonly runsDeleted: number;
}

export interface PruneRunLogsOptions {
  readonly runsDir: string;
  readonly ceilingBytes?: number;
  readonly logger?: Logger;
}

export function runsToEvict(entries: readonly RunLogEntry[], ceilingBytes: number): string[] {
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes <= ceilingBytes) return [];

  let bytesAfterEviction = totalBytes;
  const evicted: string[] = [];
  const oldestFirst = [...entries].sort((a, b) => a.createdAtMs - b.createdAtMs || a.path.localeCompare(b.path));

  for (const entry of oldestFirst) {
    if (bytesAfterEviction <= ceilingBytes) break;
    evicted.push(entry.path);
    bytesAfterEviction -= entry.bytes;
  }
  return evicted;
}

export function pruneRunLogs(opts: PruneRunLogsOptions): PruneRunLogsReport {
  const logger = opts.logger ?? noopLogger;
  const ceilingBytes = opts.ceilingBytes ?? FLIGHT_RECORDER_CEILING_BYTES;
  const entries = readRunLogEntries(opts.runsDir);
  const bytesBefore = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const paths = runsToEvict(entries, ceilingBytes);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));

  let bytesFreed = 0;
  let runsDeleted = 0;
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
      bytesFreed += entryByPath.get(path)?.bytes ?? 0;
      runsDeleted += 1;
    } catch (e) {
      logger.warn({ err: (e as Error).message, path }, "flight-recorder run log eviction failed (best-effort)");
    }
  }

  const bytesAfter = Math.max(0, bytesBefore - bytesFreed);
  if (runsDeleted > 0) {
    logger.info({ runsDeleted, bytesFreed, bytesBefore, bytesAfter, ceilingBytes }, "pruned flight-recorder run logs");
  } else {
    logger.debug({ bytesBefore, ceilingBytes }, "flight-recorder run logs within ceiling");
  }
  return { bytesBefore, bytesAfter, bytesFreed, runsDeleted };
}

function readRunLogEntries(runsDir: string): RunLogEntry[] {
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw e;
  }

  const entries: RunLogEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(runsDir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    entries.push({ path, bytes: stat.size, createdAtMs: stat.mtimeMs });
  }
  return entries;
}
