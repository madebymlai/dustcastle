import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../../detect/index.js";
import { depsCacheKey } from "./index.js";

// The deps-cache key (ADR 0012, dustcastle-8od; dustcastle-8iv.2) is the stable
// cache entry name for one locked ecosystem: resolved Toolchain version + Ecosystem +
// Package Manager + lockfile contents. A loose / no-lockfile ecosystem has no stable
// key (undefined), so it is never cached.

const projectDirs: string[] = [];
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-cachekey-"));
  projectDirs.push(dir);
  return dir;
}
afterEach(() => {
  let dir = projectDirs.pop();
  while (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = projectDirs.pop();
  }
});

const nodeNpm: Detection = { ecosystem: "node", packageManager: "npm" };
const goModules: Detection = { ecosystem: "go", packageManager: "go" };

describe("depsCacheKey (locked deps key — ADR 0012, dustcastle-8od)", () => {
  it("is a stable hash of the manager's lockfile contents", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');

    const firstKey = depsCacheKey(dir, nodeNpm);
    const secondKey = depsCacheKey(dir, nodeNpm);

    expect(firstKey).toBeDefined();
    expect(secondKey).toBe(firstKey);
  });

  it("changes when the lockfile contents change (a new lockfile ⇒ a new entry)", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const originalKey = depsCacheKey(dir, nodeNpm);

    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"name":"x"}');
    const changedKey = depsCacheKey(dir, nodeNpm);

    expect(changedKey).not.toBe(originalKey);
  });

  it("changes when the resolved Toolchain version changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');

    const node20Key = depsCacheKey(dir, { ...nodeNpm, toolchainVersion: "20.18.0" });
    const node22Key = depsCacheKey(dir, { ...nodeNpm, toolchainVersion: "22.12.0" });

    expect(node20Key).not.toBe(node22Key);
  });

  it("changes when the Package Manager changes, all else equal", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), "same locked deps\n");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "same locked deps\n");

    const npmKey = depsCacheKey(dir, { ...nodeNpm, toolchainVersion: "22.12.0" });
    const pnpmKey = depsCacheKey(dir, {
      ecosystem: "node",
      packageManager: "pnpm",
      toolchainVersion: "22.12.0",
    });

    expect(npmKey).not.toBe(pnpmKey);
  });

  it("changes when the Ecosystem changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), "same locked deps\n");

    const nodeKey = depsCacheKey(dir, {
      ecosystem: "node",
      packageManager: "npm",
      toolchainVersion: "22.12.0",
    });
    const pythonKey = depsCacheKey(dir, {
      ecosystem: "python",
      packageManager: "npm",
      toolchainVersion: "22.12.0",
    });

    expect(nodeKey).not.toBe(pythonKey);
  });

  it("is stable across irrelevant repo changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const originalKey = depsCacheKey(dir, nodeNpm);

    writeFileSync(join(dir, "README.md"), "changed prose\n");
    const changedRepoKey = depsCacheKey(dir, nodeNpm);

    expect(changedRepoKey).toBe(originalKey);
  });

  it("includes every present lockfile for managers with companion lockfiles", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n");
    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:abc\n");
    const originalKey = depsCacheKey(dir, goModules);

    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:def\n");
    const changedKey = depsCacheKey(dir, goModules);

    expect(changedKey).not.toBe(originalKey);
  });

  it("is undefined for a loose / no-lockfile ecosystem (no stable key ⇒ not cached)", () => {
    const dir = projectDir();
    // package.json present but NO lockfile → loose.
    writeFileSync(join(dir, "package.json"), "{}");

    const key = depsCacheKey(dir, { ...nodeNpm, loose: true });

    expect(key).toBeUndefined();
  });

  it("is undefined when the manager's lockfile is absent on disk", () => {
    const dir = projectDir();

    const key = depsCacheKey(dir, nodeNpm);

    expect(key).toBeUndefined();
  });
});
