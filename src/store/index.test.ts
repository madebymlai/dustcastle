import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import type { PackageManager } from "../ecosystems/index.js";
import { isStageableSource, provisionStore, stageSource } from "./index.js";

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
      provision({ ecosystem: "node", packageManager: "bun" }),
    ).toThrowError(/bun importer is not yet supported/);
  });

  // (poetry was gated here until laimk-hse.7 proved `poetry export` hermetic; it now
  // provisions through the pure pip-FOD like uv, so its "no provisionGate" contract
  // lives in ecosystems.test.ts and its live build in the gated e2e.)

  it("rejects an unknown manager with the Registry's honest miss error", () => {
    // The closed `PackageManager` union (laimk-mhg.6) makes a name outside the
    // Registry unrepresentable in well-typed code, so this case CASTS to exercise
    // the never-drop-a-gate safety net (ADR 0004). The store's own defensive guard
    // has RETIRED (architecture review candidate 2: dispatch is exhaustive by
    // construction); the single remaining net is the Registry lookup's own throw.
    expect(() =>
      provision({ ecosystem: "node", packageManager: "mystery" as PackageManager }),
    ).toThrowError(/unknown package manager mystery/);
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

describe("stageSource (honors git's ignore rules so the deps hash is stable)", () => {
  const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

  function gitProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-"));
    tmps.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "index.js"), "export const x = 1;\n");
    return dir;
  }

  it("excludes .gitignored files (the deps build must not see gitignored junk)", () => {
    const dir = gitProject();
    writeFileSync(join(dir, ".gitignore"), "*.db\nscratch/\n");
    writeFileSync(join(dir, "scratch.db"), "binary");
    mkdirSync(join(dir, "scratch"));
    writeFileSync(join(dir, "scratch", "tmp.txt"), "junk");
    const dest = mkdtempSync(join(tmpdir(), "dustcastle-stage-dest-"));
    tmps.push(dest);
    stageSource(dir, join(dest, "src"));
    expect(existsSync(join(dest, "src", "package.json"))).toBe(true);
    expect(existsSync(join(dest, "src", "index.js"))).toBe(true);
    expect(existsSync(join(dest, "src", "scratch.db"))).toBe(false);
    expect(existsSync(join(dest, "src", "scratch"))).toBe(false);
  });

  it("honors .git/info/exclude (a local, uncommitted ignore source)", () => {
    const dir = gitProject();
    writeFileSync(join(dir, ".git", "info", "exclude"), "secret.txt\n");
    writeFileSync(join(dir, "secret.txt"), "do-not-stage");
    const dest = mkdtempSync(join(tmpdir(), "dustcastle-stage-dest-"));
    tmps.push(dest);
    stageSource(dir, join(dest, "src"));
    expect(existsSync(join(dest, "src", "secret.txt"))).toBe(false);
    expect(existsSync(join(dest, "src", "package.json"))).toBe(true);
  });

  it("excludes rebuild artifacts even when a project tracks them (node_modules)", () => {
    const dir = gitProject();
    // No .gitignore for node_modules — force-track it; staging must still drop it.
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports={}");
    git(dir, "add", "-A", "-f");
    const dest = mkdtempSync(join(tmpdir(), "dustcastle-stage-dest-"));
    tmps.push(dest);
    stageSource(dir, join(dest, "src"));
    expect(existsSync(join(dest, "src", "node_modules"))).toBe(false);
    expect(existsSync(join(dest, "src", "index.js"))).toBe(true);
  });

  it("falls back to the static skip-set copy outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-nogit-"));
    tmps.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    const dest = mkdtempSync(join(tmpdir(), "dustcastle-stage-dest-"));
    tmps.push(dest);
    stageSource(dir, join(dest, "src")); // no .git → fallback path
    expect(existsSync(join(dest, "src", "package.json"))).toBe(true);
    expect(existsSync(join(dest, "src", "node_modules"))).toBe(false);
  });
});
