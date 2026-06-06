import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitHeadAuthoredSource, readWorktreeAuthoredSource } from "./authoredSource.js";

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-authoredsrc-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** Create a committed git repo in a temp dir with the given file tree. */
function committedProject(files: Record<string, string>): string {
  const dir = tmp();
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("readGitHeadAuthoredSource (committed HEAD content reader)", () => {
  it("returns HEAD content for a committed file", () => {
    const dir = committedProject({ "package.json": '{"name":"app"}' });
    const content = readGitHeadAuthoredSource(dir, "package.json");
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString()).toBe('{"name":"app"}');
  });

  it("returns undefined for a file not in HEAD (untracked or uncommitted)", () => {
    const dir = committedProject({ "package.json": '{"name":"app"}' });
    // Write an untracked file
    writeFileSync(join(dir, "requirements.txt"), "numpy==1.0");

    const content = readGitHeadAuthoredSource(dir, "requirements.txt");
    expect(content).toBeUndefined();
  });

  it("returns undefined for a file deleted from HEAD (committed removal)", () => {
    const dir = committedProject({ "package.json": '{"name":"app"}', "stale.txt": "old" });
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    // Delete from disk and commit the removal
    unlinkSync(join(dir, "stale.txt"));
    git("add", "-A");
    git("commit", "-q", "-m", "remove");

    const content = readGitHeadAuthoredSource(dir, "stale.txt");
    expect(content).toBeUndefined();
  });

  it("degrades to worktree content when the project has no HEAD (no commits)", () => {
    const dir = tmp();
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    // No commit yet — HEAD doesn't resolve
    writeFileSync(join(dir, "package.json"), '{"name":"no-commit-yet"}');

    const content = readGitHeadAuthoredSource(dir, "package.json");
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString()).toBe('{"name":"no-commit-yet"}');
  });

  it("degrades to worktree content when the project is not a git repo", () => {
    const dir = tmp();
    writeFileSync(join(dir, "package.json"), '{"name":"not-git"}');

    const content = readGitHeadAuthoredSource(dir, "package.json");
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString()).toBe('{"name":"not-git"}');
  });

  it("returns undefined for a worktree file that is absent from disk too (no degrade fallback)", () => {
    const dir = tmp();
    const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    // No commit AND no file on disk

    const content = readGitHeadAuthoredSource(dir, "nonexistent.json");
    expect(content).toBeUndefined();
  });

  it("returns HEAD content and ignores worktree modifications", () => {
    const dir = committedProject({ "package.json": '{"name":"committed"}' });
    // Modify the worktree file without committing
    writeFileSync(join(dir, "package.json"), '{"name":"dirty-worktree"}');

    const content = readGitHeadAuthoredSource(dir, "package.json");
    expect(content).toBeInstanceOf(Buffer);
    // Must return the committed content, not the dirty worktree
    expect(content!.toString()).toBe('{"name":"committed"}');
  });

  it("reads the file at projectDir, not the repo root, when projectDir is a subdirectory", () => {
    // A monorepo: a same-named dependency file at the root AND in a member subdir.
    // The reader must address it relative to projectDir (the member), not the repo
    // root — git's `HEAD:<path>` is root-relative by default, which is the bug.
    const root = committedProject({
      "package.json": '{"name":"root"}',
      "packages/foo/package.json": '{"name":"foo"}',
    });

    const content = readGitHeadAuthoredSource(join(root, "packages", "foo"), "package.json");
    expect(content).toBeInstanceOf(Buffer);
    expect(content!.toString()).toBe('{"name":"foo"}');
  });

  it("agrees with the worktree reader for the same (projectDir, file) in a subdirectory", () => {
    // The two AuthoredSource adapters must be substitutable: given the same
    // projectDir they must resolve the same logical file. A subdir is where they
    // used to diverge (worktree → subdir file, git-HEAD → repo-root file).
    const root = committedProject({
      "package.json": '{"name":"root"}',
      "packages/foo/package.json": '{"name":"foo"}',
    });
    const member = join(root, "packages", "foo");

    expect(readGitHeadAuthoredSource(member, "package.json")).toEqual(
      readWorktreeAuthoredSource(member, "package.json"),
    );
  });
});
