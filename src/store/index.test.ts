import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import type { PackageManager } from "../ecosystems/index.js";
import { isStageableSource, provisionStore } from "./index.js";

// The store dispatch (slice 2b): which importer a detection routes to, and how
// unbuilt importers are gated. These cases throw inside the `switch` before any
// nix-portable build runs, so they need no toolchain — they pin the routing
// contract and the honest bun gate. The live builds are proven by the gated e2e.

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function stagedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-store-dispatch-"));
  tmps.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}

const provision = (detection: Detection) =>
  provisionStore({
    projectDir: stagedProject(),
    detection,
    // A bogus nix-portable path is fine: the cases under test throw before `run`.
    nixPortable: "/nonexistent/nix-portable",
  });

describe("provisionStore dispatch (slice 2b importer routing)", () => {
  it("gates bun explicitly: nixpkgs has no canonical bun importer yet", () => {
    expect(() =>
      provision({ ecosystem: "node", packageManager: "bun", importer: "fetchBunDeps" }),
    ).toThrowError(/bun importer is not yet supported/);
  });

  // (poetry was gated here until laimk-hse.7 proved `poetry export` hermetic; it now
  // provisions through the pure pip-FOD like uv, so its "no provisionGate" contract
  // lives in ecosystems.test.ts and its live build in the gated e2e.)

  it("rejects an unknown importer with a clear, listing error", () => {
    // The closed `PackageManager` union (laimk-mhg.6) makes a name outside the
    // Registry unrepresentable in well-typed code, so this case CASTS to exercise
    // the store's defensive Registry-miss guard — the never-drop-a-gate safety net
    // that survives a caller widening the type (ADR 0004).
    expect(() =>
      provision({ ecosystem: "node", packageManager: "mystery" as PackageManager, importer: "fetchMysteryDeps" }),
    ).toThrowError(/unsupported importer fetchMysteryDeps/);
  });
});

describe("isStageableSource (the staged-build-source filter)", () => {
  it("stages real project source", () => {
    for (const p of ["src/app.py", "pyproject.toml", "poetry.lock", "requirements.txt", "go.mod", "package.json"]) {
      expect(isStageableSource(p)).toBe(true);
    }
  });

  it("excludes VCS metadata and nix build outputs", () => {
    for (const p of ["/proj/.git", "/proj/result", "/proj/result-2", "/proj/result-bin"]) {
      expect(isStageableSource(p)).toBe(false);
    }
  });

  it("excludes per-ecosystem dependency dirs (node_modules, vendor)", () => {
    expect(isStageableSource("/proj/node_modules")).toBe(false);
    expect(isStageableSource("/proj/vendor")).toBe(false);
  });

  it("excludes Python envs and dev caches (.venv and the rest — the node_modules analogues)", () => {
    for (const name of [".venv", ".tox", "__pycache__", ".mypy_cache", ".pytest_cache"]) {
      expect(isStageableSource(`/proj/${name}`)).toBe(false);
      // nested too — cpSync filters every entry by basename
      expect(isStageableSource(`/proj/pkg/${name}`)).toBe(false);
    }
  });

  it("does not over-match names that merely contain a skipped token", () => {
    // `.venv` is excluded, but `.venvrc` / `myvendor` are real source.
    expect(isStageableSource("/proj/.venvrc")).toBe(true);
    expect(isStageableSource("/proj/myvendor")).toBe(true);
    expect(isStageableSource("/proj/results.txt")).toBe(true);
  });
});
