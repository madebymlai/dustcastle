import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../../detect/index.js";
import { depsCacheDecision, populateCommand, restoreCommand } from "./index.js";

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
    mkdirSync(join(cacheDir, decisionMiss!.lockfileHash!), { recursive: true });

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

describe("deps-cache shell command builders (copy assembled deps — ADR 0012)", () => {
  it("restores a hit from the cache content path and touches the entry dir for recency", () => {
    const cmd = restoreCommand({
      cacheDir: "/c",
      lockfileHash: "abc",
      stageDir: "node_modules",
    });

    expect(cmd).toBe(
      "if [ -d '/c/abc/node_modules' ]; then " +
        "rm -rf 'node_modules' && cp -RL '/c/abc/node_modules' 'node_modules' && chmod -R u+rwX 'node_modules' && touch '/c/abc'; " +
        "fi",
    );
  });

  it("populates the cache content path from the worktree's assembled stage dir", () => {
    const cmd = populateCommand({
      cacheDir: "/c",
      lockfileHash: "abc",
      stageDir: "node_modules",
    });

    expect(cmd).toBe(
      "if [ -d 'node_modules' ]; then " +
        "mkdir -p '/c/abc' && rm -rf '/c/abc/node_modules' && cp -RL 'node_modules' '/c/abc/node_modules'; " +
        "fi",
    );
  });
});
