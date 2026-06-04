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

const dirs: string[] = [];
function projectDir(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-cachekey-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const npm: Detection = { ecosystem: "node", packageManager: "npm" };
const go: Detection = { ecosystem: "go", packageManager: "go" };

describe("depsCacheKey (locked deps key — ADR 0012, dustcastle-8od)", () => {
  it("is a stable hash of the manager's lockfile contents", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');

    const key = depsCacheKey(dir, npm);
    expect(key).toBeDefined();
    // Stable: the same lockfile contents hash to the same key.
    expect(depsCacheKey(dir, npm)).toBe(key);
  });

  it("changes when the lockfile contents change (a new lockfile ⇒ a new entry)", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const before = depsCacheKey(dir, npm);
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3,"name":"x"}');
    const after = depsCacheKey(dir, npm);
    expect(after).not.toBe(before);
  });

  it("changes when the resolved Toolchain version changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');

    expect(depsCacheKey(dir, { ...npm, toolchainVersion: "20.18.0" })).not.toBe(
      depsCacheKey(dir, { ...npm, toolchainVersion: "22.12.0" }),
    );
  });

  it("changes when the Package Manager changes, all else equal", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), "same locked deps\n");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "same locked deps\n");

    expect(depsCacheKey(dir, { ...npm, toolchainVersion: "22.12.0" })).not.toBe(
      depsCacheKey(dir, {
        ecosystem: "node",
        packageManager: "pnpm",
        toolchainVersion: "22.12.0",
      }),
    );
  });

  it("changes when the Ecosystem changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), "same locked deps\n");

    expect(
      depsCacheKey(dir, { ecosystem: "node", packageManager: "npm", toolchainVersion: "22.12.0" }),
    ).not.toBe(
      depsCacheKey(dir, {
        ecosystem: "python",
        packageManager: "npm",
        toolchainVersion: "22.12.0",
      }),
    );
  });

  it("is stable across irrelevant repo changes", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}');
    const before = depsCacheKey(dir, npm);

    writeFileSync(join(dir, "README.md"), "changed prose\n");

    expect(depsCacheKey(dir, npm)).toBe(before);
  });

  it("includes every present lockfile for managers with companion lockfiles", () => {
    const dir = projectDir();
    writeFileSync(join(dir, "go.mod"), "module example.com/app\n");
    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:abc\n");
    const before = depsCacheKey(dir, go);

    writeFileSync(join(dir, "go.sum"), "example.com/dep v1 h1:def\n");

    expect(depsCacheKey(dir, go)).not.toBe(before);
  });

  it("is undefined for a loose / no-lockfile ecosystem (no stable key ⇒ not cached)", () => {
    const dir = projectDir();
    // package.json present but NO lockfile → loose.
    writeFileSync(join(dir, "package.json"), "{}");
    expect(depsCacheKey(dir, { ...npm, loose: true })).toBeUndefined();
  });

  it("is undefined when the manager's lockfile is absent on disk", () => {
    const dir = projectDir();
    expect(depsCacheKey(dir, npm)).toBeUndefined();
  });
});
