import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../nix/rust.js";
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

  it("excludes per-ecosystem dependency dirs (node_modules, vendor, staged CARGO_HOME)", () => {
    expect(isStageableSource("/proj/node_modules")).toBe(false);
    expect(isStageableSource("/proj/vendor")).toBe(false);
    expect(isStageableSource(`/proj/${CARGO_HOME_BASENAME}`)).toBe(false);
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

describe("stageSource (stages the committed tree so the deps hash is reproducible)", () => {
  const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

  // A git project with one commit, so HEAD has a tree to stage. stageSource reads
  // the COMMITTED tree (`git archive HEAD`), not the working dir — so fixtures must
  // commit anything they expect to be staged.
  function gitProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-"));
    tmps.push(dir);
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@t");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "index.js"), "export const x = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    return dir;
  }

  const destDir = () => {
    const dest = mkdtempSync(join(tmpdir(), "dustcastle-stage-dest-"));
    tmps.push(dest);
    return join(dest, "src");
  };

  it("stages only the committed tree — untracked files never reach the build", () => {
    const dir = gitProject();
    // Junk that lives in the work tree but was never committed (gitignored or not):
    // the committed-tree model excludes it by construction — no .gitignore needed.
    writeFileSync(join(dir, "scratch.db"), "binary");
    mkdirSync(join(dir, "scratch"));
    writeFileSync(join(dir, "scratch", "tmp.txt"), "junk");
    const src = destDir();
    stageSource(dir, src);
    expect(existsSync(join(src, "package.json"))).toBe(true);
    expect(existsSync(join(src, "index.js"))).toBe(true);
    expect(existsSync(join(src, "scratch.db"))).toBe(false);
    expect(existsSync(join(src, "scratch"))).toBe(false);
  });

  it("stages committed content, not uncommitted edits to tracked files", () => {
    // The (b) tradeoff: editing a tracked file on disk without committing must not
    // change the build — the deps hash tracks commits, not the dirty work tree.
    const dir = gitProject();
    writeFileSync(join(dir, "index.js"), "export const x = 999; // uncommitted edit\n");
    const src = destDir();
    stageSource(dir, src);
    expect(readFileSync(join(src, "index.js"), "utf8")).toBe("export const x = 1;\n");
  });

  it("excludes rebuild artifacts even when a project commits them (node_modules)", () => {
    const dir = gitProject();
    // No .gitignore for node_modules — commit it; staging must still drop it.
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports={}");
    git(dir, "add", "-A", "-f");
    git(dir, "commit", "-q", "-m", "track node_modules");
    const src = destDir();
    stageSource(dir, src);
    expect(existsSync(join(src, "node_modules"))).toBe(false);
    expect(existsSync(join(src, "index.js"))).toBe(true);
  });

  it("does not crash on index/worktree skew (a tracked file deleted from disk, unstaged)", () => {
    // The phantom-file bug (`.beads/.beads/.gitignore`): a committed file deleted from
    // disk WITHOUT staging the deletion. The old code listed it then copied from disk
    // → ENOENT. Reading the committed tree from blobs can't ENOENT, and HEAD still has
    // the file, so it is materialized from its blob — git-faithful and crash-free.
    const dir = gitProject();
    writeFileSync(join(dir, "ghost.js"), "export const ghost = 1;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add ghost");
    rmSync(join(dir, "ghost.js")); // gone from disk, deletion NOT staged → the skew
    const src = destDir();
    expect(() => stageSource(dir, src)).not.toThrow();
    expect(existsSync(join(src, "ghost.js"))).toBe(true); // restored from HEAD's blob
    expect(existsSync(join(src, "index.js"))).toBe(true);
  });

  it("materializes a committed symlink, dangling target and all", () => {
    // git stores symlinks as blobs; `git archive` + tar recreate them as links even
    // when the target is missing — no special copy handling needed.
    const dir = gitProject();
    symlinkSync("does-not-exist", join(dir, "link.txt"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add dangling symlink");
    const src = destDir();
    expect(() => stageSource(dir, src)).not.toThrow();
    expect(lstatSync(join(src, "link.txt")).isSymbolicLink()).toBe(true);
  });

  it("falls back to a filtered copy outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-nogit-"));
    tmps.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    const src = destDir();
    stageSource(dir, src); // no .git → fallback path
    expect(existsSync(join(src, "package.json"))).toBe(true);
    expect(existsSync(join(src, "node_modules"))).toBe(false);
  });

  it("falls back to a filtered copy in a git repo with no commit yet (no HEAD)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-nohead-"));
    tmps.push(dir);
    git(dir, "init", "-q"); // a work tree, but `git archive HEAD` has nothing to read
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    const src = destDir();
    stageSource(dir, src);
    expect(existsSync(join(src, "package.json"))).toBe(true);
    expect(existsSync(join(src, "node_modules"))).toBe(false);
  });
});
