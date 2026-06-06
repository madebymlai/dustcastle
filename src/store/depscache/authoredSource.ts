import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads the authored content for one dependency-determining file. Undefined means
 * the file is absent from that authored view and should not enter the deps key.
 */
export type AuthoredSourceReader = (projectDir: string, fileName: string) => Buffer | undefined;

/** Production default for the seam: the current live worktree, preserving legacy keys. */
export function readWorktreeAuthoredSource(projectDir: string, fileName: string): Buffer | undefined {
  const filePath = join(projectDir, fileName);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath);
}
