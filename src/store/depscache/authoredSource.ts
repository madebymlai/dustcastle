import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the authored content for one dependency-determining file. Undefined means
 * the file is absent from that authored view and should not enter the deps key.
 */
export type AuthoredSourceReader = (projectDir: string, fileName: string) => Buffer | undefined;

/** Worktree reader: the current live worktree on disk, used as fallback for no-HEAD repos. */
export function readWorktreeAuthoredSource(projectDir: string, fileName: string): Buffer | undefined {
  const filePath = join(projectDir, fileName);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath);
}

/**
 * Production default for the Authored Source seam: reads a file's committed content
 * at git HEAD. A file not in HEAD (untracked, uncommitted, or install-written) returns
 * undefined and is invisible to the deps fingerprint. A project with no HEAD (no
 * commits, or not a git repo) degrades gracefully to the live worktree reader.
 */
export function readGitHeadAuthoredSource(projectDir: string, fileName: string): Buffer | undefined {
  const head = spawnSync(
    "git",
    ["-C", projectDir, "rev-parse", "-q", "--verify", "HEAD^{commit}"],
    { encoding: "utf8" },
  );
  if (head.status !== 0) {
    // No HEAD — degrade to worktree content
    return readWorktreeAuthoredSource(projectDir, fileName);
  }

  const show = spawnSync(
    "git",
    ["-C", projectDir, "show", `HEAD:${fileName}`],
    { encoding: "buffer" },
  );
  if (show.status !== 0) {
    // File not in HEAD — absent from authored source
    return undefined;
  }
  return show.stdout;
}
