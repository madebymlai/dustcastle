import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRecency, recencyPath, upsertRecency } from "./recency.js";

// The recency index (ADR 0007) — derived STATE, never config, so it lives in its
// own `~/.dustcastle/recency.json` (not config.json — ADR 0009). `run()` upserts
// the current project's last-use + closure size; the sweep reads it to pick the
// byte-budget warm set. Writes are atomic (temp + rename) and last-writer-wins;
// a missing/corrupt file MUST degrade to an empty tail — it can never crash a run.
// `dir` is injected at a throwaway temp path so tests never touch the real home.

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-recency-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("loadRecency (degrade-to-empty — never crashes a run — ADR 0007)", () => {
  it("returns an empty tail when no recency file exists yet", () => {
    expect(loadRecency(home())).toEqual([]);
  });

  it("returns an empty tail on corrupt JSON (bad state never crashes)", () => {
    const dir = home();
    writeFileSync(recencyPath(dir), "{ not json");
    expect(loadRecency(dir)).toEqual([]);
  });

  it("returns an empty tail when the envelope is the wrong shape", () => {
    const dir = home();
    writeFileSync(recencyPath(dir), JSON.stringify([1, 2, 3]));
    expect(loadRecency(dir)).toEqual([]);
  });
});

describe("upsertRecency (atomic, last-writer-wins — ADR 0007)", () => {
  it("round-trips a record through the version envelope", () => {
    const dir = home();
    upsertRecency(dir, { projectKey: "npm-abc=", lastUsedAt: 1000, closureBytes: 5000 });
    expect(loadRecency(dir)).toEqual([{ projectKey: "npm-abc=", lastUsedAt: 1000, closureBytes: 5000 }]);
  });

  it("merges a new key while preserving the others (last-writer-wins per key)", () => {
    const dir = home();
    upsertRecency(dir, { projectKey: "npm-a=", lastUsedAt: 100, closureBytes: 10 });
    upsertRecency(dir, { projectKey: "npm-b=", lastUsedAt: 200, closureBytes: 20 });
    upsertRecency(dir, { projectKey: "npm-a=", lastUsedAt: 300, closureBytes: 30 }); // bump a

    const byKey = Object.fromEntries(loadRecency(dir).map((r) => [r.projectKey, r]));
    expect(byKey["npm-a="]).toEqual({ projectKey: "npm-a=", lastUsedAt: 300, closureBytes: 30 });
    expect(byKey["npm-b="]).toEqual({ projectKey: "npm-b=", lastUsedAt: 200, closureBytes: 20 });
  });

  it("writes a versioned envelope to recency.json (state, not config)", () => {
    const dir = home();
    upsertRecency(dir, { projectKey: "npm-a=", lastUsedAt: 100, closureBytes: 10 });
    const onDisk = JSON.parse(readFileSync(recencyPath(dir), "utf8"));
    expect(onDisk.version).toBe(1);
    expect(onDisk.projects["npm-a="]).toEqual({ lastUsedAt: 100, closureBytes: 10 });
  });

  it("leaves no temp file behind after the atomic rename", () => {
    const dir = home();
    upsertRecency(dir, { projectKey: "npm-a=", lastUsedAt: 100, closureBytes: 10 });
    expect(readdirSync(dir)).toEqual(["recency.json"]);
  });
});
