import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHIVE_SCRATCH_PREFIX,
  BUILD_SCRATCH_PREFIX,
  sweepOrphanedScratch,
  withTempDir,
} from "./scratch.js";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000; // fixed epoch ms so staleness is deterministic
const HOUR = 60 * 60 * 1000;

// An isolated stand-in for the OS temp dir, so a sweep can't touch real /tmp entries.
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-sweep-root-"));
  tmps.push(dir);
  return dir;
}

// A scratch dir owned by `pid`, named exactly as withTempDir names them
// (`<prefix><pid>-<rand>`) so the reaper can attribute it to an owner.
function ownedDir(root: string, prefix: string, pid: number): string {
  return mkdtempSync(join(root, `${prefix}${pid}-`));
}

// An owned scratch dir whose mtime is backdated `ageMs` before NOW (for backstop tests).
function ownedAgedDir(root: string, prefix: string, pid: number, ageMs: number): string {
  const dir = ownedDir(root, prefix, pid);
  const mtimeSec = (NOW - ageMs) / 1000;
  utimesSync(dir, mtimeSec, mtimeSec);
  return dir;
}

describe("withTempDir (mkdtemp paired with guaranteed cleanup)", () => {
  it("runs fn with a fresh dir, returns its value, and removes the dir after", () => {
    let seen = "";
    const value = withTempDir("dustcastle-scratch-test-", (dir) => {
      seen = dir;
      writeFileSync(join(dir, "f.txt"), "x");
      return 42;
    });
    expect(value).toBe(42);
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false);
  });

  it("names the dir with the owner PID so a reaper can attribute liveness", () => {
    let name = "";
    withTempDir("dustcastle-scratch-test-", (dir) => {
      name = basename(dir);
    });
    expect(name.startsWith(`dustcastle-scratch-test-${process.pid}-`)).toBe(true);
  });

  it("removes the dir and rethrows when a sync fn throws", () => {
    let seen = "";
    expect(() =>
      withTempDir("dustcastle-scratch-test-", (dir) => {
        seen = dir;
        writeFileSync(join(dir, "f.txt"), "x");
        throw new Error("boom");
      }),
    ).toThrowError("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it("keeps the dir alive until an async fn resolves, then removes it", async () => {
    let seen = "";
    const existedDuringAwait = await withTempDir("dustcastle-scratch-test-", async (dir) => {
      seen = dir;
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 5));
      return existsSync(dir); // the dir must still be here mid-flight
    });
    expect(existedDuringAwait).toBe(true);
    expect(seen).not.toBe("");
    expect(existsSync(seen)).toBe(false); // ...and gone once the promise settles
  });

  it("removes the dir and propagates when an async fn rejects", async () => {
    let seen = "";
    await expect(
      withTempDir("dustcastle-scratch-test-", async (dir) => {
        seen = dir;
        await Promise.resolve();
        throw new Error("async boom");
      }),
    ).rejects.toThrowError("async boom");
    expect(existsSync(seen)).toBe(false);
  });
});

describe("sweepOrphanedScratch (reaps crash-leaked scratch dirs by owner liveness)", () => {
  it("reaps a dir whose owner process is dead, keeps one whose owner is alive", () => {
    const root = scratchRoot();
    const LIVE = 4242;
    const DEAD = 777;
    const live = ownedDir(root, BUILD_SCRATCH_PREFIX, LIVE);
    const dead = ownedDir(root, BUILD_SCRATCH_PREFIX, DEAD);
    const report = sweepOrphanedScratch({ tmpDir: root, now: () => NOW, isOwnerAlive: (pid) => pid === LIVE });
    expect(existsSync(live)).toBe(true); // a live build is never touched, whatever its age
    expect(existsSync(dead)).toBe(false); // the crash-orphan is reclaimed immediately
    expect(report.dirsDeleted).toBe(1);
  });

  it("ignores foreign entries and non-dir name matches", () => {
    const root = scratchRoot();
    const foreign = ownedDir(root, "some-other-tool-", 4242); // not our prefix
    const strayFile = join(root, `${BUILD_SCRATCH_PREFIX}stray.txt`);
    writeFileSync(strayFile, "x");
    const report = sweepOrphanedScratch({ tmpDir: root, now: () => NOW, isOwnerAlive: () => false });
    expect(existsSync(foreign)).toBe(true); // foreign prefix → not ours
    expect(existsSync(strayFile)).toBe(true); // a file, not a scratch dir
    expect(report.dirsDeleted).toBe(0);
  });

  it("reaps both build and archive orphans and skips a missing temp dir", () => {
    const root = scratchRoot();
    ownedDir(root, BUILD_SCRATCH_PREFIX, 777);
    ownedDir(root, ARCHIVE_SCRATCH_PREFIX, 778);
    expect(sweepOrphanedScratch({ tmpDir: root, now: () => NOW, isOwnerAlive: () => false }).dirsDeleted).toBe(2);
    // A non-existent temp dir degrades to a no-op, never throws.
    const gone = join(root, "does-not-exist");
    expect(sweepOrphanedScratch({ tmpDir: gone, now: () => NOW, isOwnerAlive: () => false }).dirsDeleted).toBe(0);
  });

  it("reaps an old-format (no owner PID) dir — it can have no live owner", () => {
    const root = scratchRoot();
    const legacy = mkdtempSync(join(root, BUILD_SCRATCH_PREFIX)); // no <pid>- segment
    const report = sweepOrphanedScratch({ tmpDir: root, now: () => NOW, isOwnerAlive: () => true });
    expect(existsSync(legacy)).toBe(false); // unattributable → orphan, even if oracle says alive
    expect(report.dirsDeleted).toBe(1);
  });

  it("reports the bytes reclaimed from removed orphans", () => {
    const root = scratchRoot();
    const dead = ownedDir(root, BUILD_SCRATCH_PREFIX, 777);
    writeFileSync(join(dead, "blob.bin"), Buffer.alloc(4096));
    const report = sweepOrphanedScratch({ tmpDir: root, now: () => NOW, isOwnerAlive: () => false });
    expect(report.bytesFreed).toBeGreaterThanOrEqual(4096);
  });

  it("backstop: reaps an alive-looking owner's dir once it ages past maxAge (PID reuse)", () => {
    const root = scratchRoot();
    const DAY = 24 * HOUR;
    // Same PID, both reported "alive": the aged one is a stale PID-reuse collision the
    // backstop must reclaim; the fresh one is a real live build the backstop must spare.
    const collision = ownedAgedDir(root, BUILD_SCRATCH_PREFIX, 4242, 8 * DAY);
    const fresh = ownedDir(root, BUILD_SCRATCH_PREFIX, 4242);
    const report = sweepOrphanedScratch({
      tmpDir: root,
      now: () => NOW,
      maxAgeMs: 7 * DAY,
      isOwnerAlive: () => true,
    });
    expect(existsSync(collision)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(report.dirsDeleted).toBe(1);
  });

  it("default oracle: keeps our own live process's dir, reaps a foreign-PID one", () => {
    const root = scratchRoot();
    // No injected oracle → the real kill(pid,0) + /proc identity check runs.
    const mine = ownedDir(root, BUILD_SCRATCH_PREFIX, process.pid); // alive, same kind as self
    const foreign = ownedDir(root, BUILD_SCRATCH_PREFIX, 1); // pid 1 (init) → never our owner
    const report = sweepOrphanedScratch({ tmpDir: root, now: () => NOW });
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(foreign)).toBe(false);
    expect(report.dirsDeleted).toBe(1);
  });
});
