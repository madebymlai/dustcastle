import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
