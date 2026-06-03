import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { CARGO_HOME_BASENAME } from "../ecosystems/rust.js";
import type { Detection } from "../detect/index.js";
import type { PackageManager } from "../ecosystems/index.js";
import { createMemoryLogger } from "../log/fake.js";
import { isStageableSource, provisionStore, stageSource } from "./index.js";

// The store dispatch: which descriptor a detection routes to. The case under test
// throws in the Registry lookup before any nix-portable build runs, so it needs no
// toolchain — it pins the routing contract's never-drop-a-gate safety net. There is
// no bun gate any more (ADR 0012): bun provisions like every other manager. The live
// builds are proven by the gated e2e.

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function stagedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-store-dispatch-"));
  tmps.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  // provisionStore stages the COMMITTED tree, so the fixture must be a committed git
  // repo to get past staging and reach the dispatch/gate logic these tests pin.
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

const provision = (detection: Detection) =>
  provisionStore({
    projectDir: stagedProject(),
    detection,
    // A bogus nix-portable path is fine: the cases under test throw before `run`.
    nixPortable: "/nonexistent/nix-portable",
  });

function fakeNixPortable(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-fake-nix-portable-"));
  tmps.push(dir);
  const bin = join(dir, "nix-portable");
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("provisionStore dispatch", () => {
  it("rejects an unknown manager with the Registry's honest miss error", async () => {
    // The closed `PackageManager` union (laimk-mhg.6) makes a name outside the
    // Registry unrepresentable in well-typed code, so this case CASTS to exercise
    // the never-drop-a-gate safety net (ADR 0004). The store's own defensive guard
    // has RETIRED (architecture review candidate 2: dispatch is exhaustive by
    // construction); the single remaining net is the Registry lookup's own throw.
    await expect(
      provision({ ecosystem: "node", packageManager: "mystery" as PackageManager }),
    ).rejects.toThrowError(/unknown package manager mystery/);
  });

  it("parses the Store path from accumulated nix-build stdout and curates progress", async () => {
    const logger = createMemoryLogger();
    const provisioned = await provisionStore({
      projectDir: stagedProject(),
      detection: { ecosystem: "node", packageManager: "npm" },
      nixPortable: fakeNixPortable(
        "process.stderr.write('building toolchain\\n'); process.stdout.write('/nix/store/abc-toolchain\\n');",
      ),
      logger,
    });

    expect(provisioned.toolchainStorePath).toBe("/nix/store/abc-toolchain");
    expect(logger.records).toContainEqual(
      expect.objectContaining({ level: "info", fields: expect.objectContaining({ line: "building toolchain" }) }),
    );
  });

  it("preserves the stderr tail on a failed nix-build", async () => {
    const stderr = `HEAD${"x".repeat(2200)}TAIL`;
    let error: Error | undefined;
    try {
      await provisionStore({
        projectDir: stagedProject(),
        detection: { ecosystem: "node", packageManager: "npm" },
        nixPortable: fakeNixPortable(`process.stderr.write(${JSON.stringify(stderr)}); process.exit(23);`),
      });
    } catch (e) {
      error = e as Error;
    }

    expect(error?.message).toContain(stderr.slice(-2000));
    expect(error?.message).not.toContain("HEAD");
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

describe("stageSource (stages the committed tree for reproducible Store inputs)", () => {
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
    // change the build input — Store provisioning tracks commits, not the dirty work tree.
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

  it("errors with an actionable 'commit first' message outside a git work tree", () => {
    // No working-dir fallback: a non-git project has no committed source to build.
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-nogit-"));
    tmps.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => stageSource(dir, destDir())).toThrowError(/nothing committed to stage.*commit/s);
  });

  it("errors with an actionable 'commit first' message in a git repo with no commit yet", () => {
    // A work tree exists, but `git archive HEAD` has nothing to read — surface it as
    // a user error to fix (commit), never silently build the uncommitted working tree.
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-stage-nohead-"));
    tmps.push(dir);
    git(dir, "init", "-q");
    writeFileSync(join(dir, "package.json"), "{}");
    expect(() => stageSource(dir, destDir())).toThrowError(/nothing committed to stage.*commit/s);
  });
});
