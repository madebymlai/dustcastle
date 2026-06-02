import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import { depsCacheKey } from "./depsCacheKey.js";

// The deps-cache key (ADR 0012, dustcastle-8od) is that ecosystem's LOCKFILE HASH —
// the stable key the cache entry is stored under, so a repeat Sandbox on the same
// lockfile restores instead of re-installing. A loose / no-lockfile ecosystem has no
// stable key (undefined), so it is never cached.

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

describe("depsCacheKey (the lockfile hash — ADR 0012, dustcastle-8od)", () => {
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
