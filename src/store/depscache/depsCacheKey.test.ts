import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../../detect/index.js";
import { depsCacheKey } from "./index.js";

// The deps-cache key (ADR 0016) is the stable cache entry name for one ecosystem:
// resolved Toolchain version + Ecosystem + Package Manager + dependency-determining
// files present for that Ecosystem (manifests ∪ selected manager lockfiles). The
// loose flag is informational; lockless repos are cacheable by their manifest inputs.

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

describe("depsCacheKey (project deps fingerprint — ADR 0016)", () => {
  it("can fingerprint dependency inputs from an injected authored-source reader", () => {
    const requested: Array<{ projectDir: string; fileName: string }> = [];
    const authoredFiles = new Map<string, Buffer>([
      ["package.json", Buffer.from('{"dependencies":{"left-pad":"1.3.0"}}\n')],
      ["package-lock.json", Buffer.from('{"lockfileVersion":3,"packages":{}}\n')],
    ]);

    const key = depsCacheKey(
      "/unused/project",
      { ...nodeNpm, toolchainVersion: "22.12.0" },
      (projectDir, fileName) => {
        requested.push({ projectDir, fileName });
        return authoredFiles.get(fileName);
      },
    );

    expect(key).toBe("69b9bc42fa5d8a8dc27e81ac8f4479be4d912ebb38ab536582cce2ad60fc2ff0");
    expect(requested).toEqual([
      { projectDir: "/unused/project", fileName: "package.json" },
      { projectDir: "/unused/project", fileName: "package-lock.json" },
    ]);
  });

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

  it("changes when a loose manifest's dependency inputs change", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package.json"), '{"dependencies":{"left-pad":"^1.3.0"}}');
    const originalKey = depsCacheKey(dir, { ...nodeNpm, loose: true });

    writeFileSync(join(dir, "package.json"), '{"dependencies":{"left-pad":"^1.3.0","is-odd":"^3.0.1"}}');
    const changedKey = depsCacheKey(dir, { ...nodeNpm, loose: true });

    expect(changedKey).not.toBe(originalKey);
  });

  it("includes dependency file names, not only their contents", () => {
    const manifestOnlyDir = projectDir();
    writeFileSync(join(manifestOnlyDir, "package.json"), "{}\n");

    const lockfileOnlyDir = projectDir();
    writeFileSync(join(lockfileOnlyDir, "package-lock.json"), "{}\n");

    const manifestKey = depsCacheKey(manifestOnlyDir, nodeNpm);
    const lockfileKey = depsCacheKey(lockfileOnlyDir, nodeNpm);

    expect(manifestKey).not.toBe(lockfileKey);
  });

  it("yields a stable defined key for a loose / no-lockfile ecosystem", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package.json"), "{}");

    const firstKey = depsCacheKey(dir, { ...nodeNpm, loose: true });
    const secondKey = depsCacheKey(dir, { ...nodeNpm, loose: true });

    expect(firstKey).toBeDefined();
    expect(secondKey).toBe(firstKey);
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

  it("includes every present manifest/lockfile once for managers with overlapping companion files", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n");
    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:abc\n");
    const originalKey = depsCacheKey(dir, goModules);

    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:def\n");
    const changedKey = depsCacheKey(dir, goModules);

    expect(changedKey).not.toBe(originalKey);
  });

  it("still returns a fingerprint when no dependency files are present", () => {
    const dir = projectDir();

    const key = depsCacheKey(dir, nodeNpm);

    expect(key).toBeDefined();
  });
});
