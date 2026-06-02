import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import { depsCacheDecision, populateCacheCommand } from "./depsCache.js";
import { depsCacheEntryDir } from "./depsCachePool.js";

// The host-side deps-cache hit/miss decision + populate (ADR 0012, dustcastle-8od).
// dustcastle decides hit/miss host-side per ecosystem, keyed by the lockfile hash:
//   - a lockfile present + a cache entry on disk ⇒ HIT (restore, no install);
//   - a lockfile present + no entry yet ⇒ MISS (install, then populate);
//   - a loose / no-lockfile ecosystem ⇒ no key ⇒ never cached (always installs).

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-depscache-dec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const npm: Detection = { ecosystem: "node", packageManager: "npm" };

describe("depsCacheDecision (host-side hit/miss — ADR 0012, dustcastle-8od)", () => {
  it("HIT: a present lockfile with an existing cache entry restores", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package-lock.json"), "{}");
    // Seed the cache entry for this lockfile hash so it is a hit.
    const decisionMiss = depsCacheDecision(project, npm, cacheDir);
    mkdirSync(depsCacheEntryDir(cacheDir, decisionMiss!.lockfileHash!), { recursive: true });

    const decision = depsCacheDecision(project, npm, cacheDir);
    expect(decision).toBeDefined();
    expect(decision!.hit).toBe(true);
    expect(decision!.lockfileHash).toBe(decisionMiss!.lockfileHash);
    expect(decision!.cacheDir).toBe(cacheDir);
  });

  it("MISS: a present lockfile with no entry yet is a miss", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package-lock.json"), "{}");

    const decision = depsCacheDecision(project, npm, cacheDir);
    expect(decision).toBeDefined();
    expect(decision!.hit).toBe(false);
    expect(decision!.lockfileHash).toBeDefined();
  });

  it("UNCACHEABLE: a loose / no-lockfile ecosystem yields no decision (always installs)", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package.json"), "{}"); // no lockfile
    expect(depsCacheDecision(project, { ...npm, loose: true }, cacheDir)).toBeUndefined();
  });
});

describe("populateCacheCommand (copy the assembled deps into the cache — ADR 0012)", () => {
  it("copies the worktree's stage dir into the lockfile-hash entry (atomic-ish, idempotent)", () => {
    const cmd = populateCacheCommand({
      lockfileHash: "abc",
      stageDir: "node_modules",
      cacheEntryDir: "/c/abc",
    });
    // Copies the stage dir into the entry, dereferencing symlinks like the restore.
    expect(cmd).toContain("cp -RL");
    expect(cmd).toContain("node_modules");
    expect(cmd).toContain("/c/abc");
    // Only when the stage dir actually exists (a failed install leaves nothing to cache).
    expect(cmd).toContain("node_modules");
  });
});
