import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DUSTCASTLE_HOME } from "../config/global.js";

/** A project's last-use timestamp + closure size, the input to the recency tail (ADR 0007). */
export interface RecencyRecord {
  /** The project's GC key (mirrors `gcProjectKey`). */
  readonly projectKey: string;
  /** When this project's closure was last used by a run (epoch ms). */
  readonly lastUsedAt: number;
  /** The on-disk size of this project's closure (bytes) — the byte-budget unit. */
  readonly closureBytes: number;
}

/**
 * The recency index (ADR 0007) — a derived-STATE record of when each project's
 * closure was last used and how big it is, the input to the byte-budget warm set.
 * It is *state*, never config, so it lives in its OWN `~/.dustcastle/recency.json`
 * (kept out of `config.json`, which is for genuine user choices — ADR 0009).
 *
 * `run()` upserts the current project's record each run; the sweep reads it to pick
 * the recency tail. Two invariants make it safe on the hot path:
 *   - **Atomic** — written to a temp file then renamed (the rename is the atomic
 *     step), so a crashed write never leaves a half-file.
 *   - **Degrade-to-empty** — a missing OR corrupt file yields an empty tail and
 *     never throws (last-writer-wins means a lost timestamp bump self-heals next
 *     run); bad state must never crash a run.
 *
 * `dir` is injectable for tests; it defaults to the dustcastle home.
 */

const RECENCY_FILE = "recency.json";
const RECENCY_VERSION = 1;

/** The on-disk envelope: a version tag + a `projectKey → {lastUsedAt, closureBytes}` map. */
interface RecencyEnvelope {
  readonly version: number;
  readonly projects: Record<string, { lastUsedAt: number; closureBytes: number }>;
}

/** Absolute path to the recency index. `dir` injectable for tests. */
export function recencyPath(dir: string = DUSTCASTLE_HOME): string {
  return join(dir, RECENCY_FILE);
}

/**
 * Load the recency records, newest-first order is the caller's concern. Degrades to
 * an empty array on ANY problem (missing file, unreadable, malformed JSON, wrong
 * shape) — bad state never crashes a run (ADR 0007).
 */
export function loadRecency(dir: string = DUSTCASTLE_HOME): RecencyRecord[] {
  const projects = readEnvelope(dir)?.projects;
  if (projects === undefined) return [];
  const records: RecencyRecord[] = [];
  for (const [projectKey, value] of Object.entries(projects)) {
    if (
      typeof value === "object" &&
      value !== null &&
      typeof value.lastUsedAt === "number" &&
      typeof value.closureBytes === "number"
    ) {
      records.push({ projectKey, lastUsedAt: value.lastUsedAt, closureBytes: value.closureBytes });
    }
  }
  return records;
}

/**
 * Upsert one project's recency record: merge it into the existing map (last-writer
 * -wins per key, preserving every other key) and write the whole envelope back
 * ATOMICALLY (temp + rename). Creates `dir` as needed. Best-effort by construction:
 * a concurrent run that lost a timestamp bump self-heals on its next run.
 */
export function upsertRecency(dir: string, record: RecencyRecord): void {
  const existing = readEnvelope(dir)?.projects ?? {};
  const next: RecencyEnvelope = {
    version: RECENCY_VERSION,
    projects: {
      ...existing,
      [record.projectKey]: { lastUsedAt: record.lastUsedAt, closureBytes: record.closureBytes },
    },
  };
  mkdirSync(dir, { recursive: true });
  // Atomic: write a temp file then rename over the target (rename is atomic on the
  // same filesystem). The pid keeps concurrent upserts from colliding on the temp.
  const target = recencyPath(dir);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, target);
}

/** Read + validate the envelope, or `undefined` on any failure (the degrade hook). */
function readEnvelope(dir: string): RecencyEnvelope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(recencyPath(dir), "utf8"));
  } catch {
    return undefined; // missing or unparseable → empty tail
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    typeof (raw as RecencyEnvelope).projects !== "object" ||
    (raw as RecencyEnvelope).projects === null
  ) {
    return undefined; // wrong shape → empty tail
  }
  return raw as RecencyEnvelope;
}
