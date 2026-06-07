import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** A single issue from the Ready set, with a deterministic branch name. */
export interface ReadyIssue {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
}

/**
 * Deterministic branch name for an issue. Re-planning the same issue always
 * yields the same branch, so accumulated progress on it is preserved.
 */
export function branchForIssue(id: string): string {
  return `sandcastle/issue-${id}`;
}

/**
 * Pure mapping from parsed `bd ready --json` output to ReadyIssue[].
 * Exported so the deterministic branch-naming contract is unit-testable
 * without shelling bd.
 */
export function mapReadyIssues(parsed: unknown): ReadyIssue[] {
  if (!Array.isArray(parsed)) {
    throw new Error("bd ready --json: expected an array");
  }
  return parsed.map((row: unknown) => {
    if (!row || typeof row !== "object") {
      throw new Error("bd ready --json: expected an array of objects");
    }
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "");
    const title = String(r.title ?? "");
    if (id === "") {
      throw new Error("bd ready --json: row missing id");
    }
    return { id, title, branch: branchForIssue(id) };
  });
}

/**
 * Pull the Ready set from beads — the issues the Orchestrator will work
 * this cycle. Runs `bd ready --exclude-type=epic -l=ready-for-agent --json`
 * and maps each row to a ReadyIssue with a deterministic branch name.
 * A non-zero exit or unparseable JSON propagates as an error (never swallowed).
 */
export function bdReady(cwd: string): ReadyIssue[] {
  const stdout = execFileSync(
    "bd",
    ["ready", "--exclude-type=epic", "-l=ready-for-agent", "--json"],
    { cwd, encoding: "utf8" },
  );
  return mapReadyIssues(JSON.parse(stdout));
}

// The orchestration prompts shell out to beads (`bd ready/show/close`). These
// two facts must hold before a run; the checks are injected so the gating logic
// stays pure and unit-testable.
export interface BeadsPreflightDeps {
  readonly hasBdBinary: () => boolean;
  readonly beadsDirExists: () => boolean;
}

export function ensureBeads(deps: BeadsPreflightDeps): void {
  if (!deps.hasBdBinary()) {
    throw new Error(
      "orchestrate: `bd` (beads) not found on PATH. Install it from " +
        "https://github.com/gastownhall/beads before running the orchestrator.",
    );
  }
  if (!deps.beadsDirExists()) {
    throw new Error(
      "orchestrate: no .beads/ directory found. Run `bd init` in the repo " +
        "to create the issue database before running the orchestrator.",
    );
  }
}

/**
 * Close epics whose children are all complete, via `bd epic close-eligible`
 * (bd owns the predicate and the cascade). Runs on the host so the close
 * persists to the real `.beads`. Returns bd's `--json` shape: the closed epic
 * ids and their count.
 */
export function closeEligibleEpics(cwd: string): { closed: string[]; count: number } {
  const stdout = execFileSync("bd", ["epic", "close-eligible", "--json"], {
    cwd,
    encoding: "utf8",
  });
  const parsed = JSON.parse(stdout) as { closed?: string[]; count?: number };
  return { closed: parsed.closed ?? [], count: parsed.count ?? 0 };
}

// Real checks for the host: bd resolvable on PATH, and a .beads/ in the repo.
export function realBeadsPreflightDeps(cwd: string): BeadsPreflightDeps {
  return {
    hasBdBinary: () => {
      try {
        execFileSync("bd", ["--version"], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    beadsDirExists: () => existsSync(resolve(cwd, ".beads")),
  };
}
