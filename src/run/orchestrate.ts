import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { orchestrationPromptPath, type PromptPhase } from "../agent/prompts.js";
import { buildPiAgent, loadModelSelection } from "../config/global.js";
import { ensureBeads, realBeadsPreflightDeps, type BeadsPreflightDeps } from "./beads.js";
import {
  withProvisionedSandbox,
  type ProvisionedSandbox,
  type ProvisionOptions,
  type SandcastleHandoff,
} from "./index.js";
import { planOutput, type PlannedIssue } from "./plan-schema.js";

export interface PhaseConfig {
  readonly maxIterations: number;
  // Only the plan phase emits a structured <plan>; structured output requires
  // maxIterations: 1 (sandcastle aborts otherwise).
  readonly structuredOutput: boolean;
}

// Per-phase iteration budgets, mirroring agentstack's loop: the implementer
// gets a long leash; plan/review/merge each run a single pass.
export function phaseConfig(phase: PromptPhase): PhaseConfig {
  switch (phase) {
    case "implement":
      return { maxIterations: 100, structuredOutput: false };
    case "plan":
      return { maxIterations: 1, structuredOutput: true };
    case "review":
    case "merge":
      return { maxIterations: 1, structuredOutput: false };
  }
}

// Deterministic branch name for an issue. Re-planning the same issue always
// yields the same branch, so accumulated progress on it is preserved.
export function branchForIssue(id: string): string {
  return `sandcastle/issue-${id}`;
}

// {{...}} substitutions for the implement prompt.
export function implementArgs(issue: PlannedIssue): Record<string, string> {
  return {
    TASK_ID: issue.id,
    ISSUE_TITLE: issue.title,
    BRANCH: issue.branch,
  };
}

// {{...}} substitutions for the review prompt. baseBranch is the branch the work
// will be merged into (used by the prompt's `git diff {{BASE_BRANCH}}...`). We use
// a custom BASE_BRANCH rather than sandcastle's reserved auto-injected
// {{TARGET_BRANCH}}, so the value is the deterministic branch we provisioned off —
// not sandcastle's "host active branch at run() time" (which is undefined for a
// per-issue worktree). agentstack's prompt left this unfilled (a latent gap).
export function reviewArgs(
  issue: PlannedIssue,
  baseBranch: string,
): Record<string, string> {
  return {
    BRANCH: issue.branch,
    BASE_BRANCH: baseBranch,
  };
}

// {{...}} substitutions for the merge prompt: markdown lists of the completed
// issues' branches and their id/title, for the merger to merge and close.
export function mergeArgs(issues: readonly PlannedIssue[]): Record<string, string> {
  return {
    BRANCHES: issues.map((i) => `- ${i.branch}`).join("\n"),
    ISSUES: issues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
  };
}

// The result of one issue's implement→review pipeline: the issue plus the
// commits it accumulated (implementer + reviewer). Only the count matters here.
export interface IssueOutcome {
  readonly issue: PlannedIssue;
  readonly commits: readonly unknown[];
}

// Of the parallel per-issue outcomes, the completed ones are those that
// fulfilled (didn't throw) and actually committed work. Only these advance to
// the merge phase; order is preserved.
export function completedFrom(
  results: readonly PromiseSettledResult<IssueOutcome>[],
): PlannedIssue[] {
  return results
    .filter(
      (r): r is PromiseFulfilledResult<IssueOutcome> => r.status === "fulfilled",
    )
    .filter((r) => r.value.commits.length > 0)
    .map((r) => r.value.issue);
}

// ── The live multi-phase loop (gated: needs a pi+bd sandbox image, a host pi
//    login, and a repo with beads issues — DUSTCASTLE_E2E on a capable host) ──

/** agentstack's MAX_ITERATIONS: plan→execute→merge cycles before stopping. */
const DEFAULT_MAX_LOOPS = 10;

export interface OrchestrateOptions extends ProvisionOptions {
  /** Max plan→execute→merge cycles (default 10). */
  readonly maxLoops?: number;
  /** Base branch the work merges into; defaults to the repo's current branch. */
  readonly targetBranch?: string;
  /** Override the beads preflight checks (tests). */
  readonly beads?: BeadsPreflightDeps;
}

/**
 * The parallel-planner-with-review loop, ported from agentstack's `.sandcastle`
 * but on dustcastle's Store-provisioned podman provider (ADR 0001/0002). Each
 * cycle: one planner reads ready beads issues and emits a `<plan>` of unblocked
 * issues; each issue is implemented then reviewed in its own per-issue sandbox in
 * parallel; one merger merges the branches that committed and closes their issues.
 * Repeats so newly-unblocked issues get picked up.
 *
 * Plan and merge run on the host checkout (`sandcastle.run`) so `bd close`
 * persists to the real `.beads`; execute runs in isolated worktrees that carry a
 * copy of `.beads` via `copyToWorktree` (the Dolt DB is git-excluded).
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  ensureBeads(opts.beads ?? realBeadsPreflightDeps(opts.cwd));

  const selection = loadModelSelection();
  if (selection === undefined) {
    throw new Error("orchestrate: no model configured. Run `dustcastle model` first.");
  }
  const agent = buildPiAgent(selection);
  const targetBranch = opts.targetBranch ?? currentGitBranch(opts.cwd);
  const maxLoops = opts.maxLoops ?? DEFAULT_MAX_LOOPS;
  const log = opts.onLine ?? (() => {});

  await withProvisionedSandbox(opts, async ({ provider, withSetupHooks }) => {
    const hooks = withSetupHooks();

    for (let loop = 1; loop <= maxLoops; loop++) {
      log(`orchestrate: planning (loop ${loop}/${maxLoops})`);
      const planned = await sandcastle.run({
        sandbox: provider,
        agent,
        promptFile: orchestrationPromptPath("plan"),
        maxIterations: phaseConfig("plan").maxIterations,
        output: planOutput,
        hooks,
      });

      // sandcastle has already validated output against planSchema at runtime;
      // annotate the boundary because zod's inferred type doesn't flow through the
      // run() overload (it widens to any).
      const issues: PlannedIssue[] = planned.output.issues;
      if (issues.length === 0) {
        log("orchestrate: nothing left to do — exiting");
        return;
      }

      log(`orchestrate: ${issues.length} unblocked issue(s) → implement + review`);
      const outcomes = await Promise.allSettled(
        issues.map((issue) =>
          executeIssue({ issue, provider, agent, hooks, targetBranch }),
        ),
      );

      const completed = completedFrom(outcomes);
      if (completed.length === 0) {
        log("orchestrate: no branch produced commits this loop — skipping merge");
        continue;
      }

      log(`orchestrate: merging ${completed.length} branch(es)`);
      await sandcastle.run({
        sandbox: provider,
        agent,
        promptFile: orchestrationPromptPath("merge"),
        promptArgs: mergeArgs(completed),
        maxIterations: phaseConfig("merge").maxIterations,
        hooks,
      });
    }
  });
}

interface ExecuteIssueArgs {
  readonly issue: PlannedIssue;
  readonly provider: ProvisionedSandbox["provider"];
  readonly agent: sandcastle.AgentProvider;
  readonly hooks: NonNullable<SandcastleHandoff["hooks"]>;
  readonly targetBranch: string;
}

/**
 * One issue's implement→review pipeline in its own per-issue sandbox (a git
 * worktree off targetBranch, carrying a copy of `.beads`). The reviewer only runs
 * if the implementer committed; both share the one sandbox/branch.
 */
async function executeIssue(args: ExecuteIssueArgs): Promise<IssueOutcome> {
  const { issue, provider, agent, hooks, targetBranch } = args;
  const sandbox = await sandcastle.createSandbox({
    sandbox: provider,
    branch: issue.branch,
    baseBranch: targetBranch,
    copyToWorktree: [".beads"],
    hooks,
  });
  try {
    const impl = await sandbox.run({
      agent,
      promptFile: orchestrationPromptPath("implement"),
      promptArgs: implementArgs(issue),
      maxIterations: phaseConfig("implement").maxIterations,
    });
    if (impl.commits.length === 0) {
      return { issue, commits: [] };
    }
    const review = await sandbox.run({
      agent,
      promptFile: orchestrationPromptPath("review"),
      promptArgs: reviewArgs(issue, targetBranch),
      maxIterations: phaseConfig("review").maxIterations,
    });
    return { issue, commits: [...impl.commits, ...review.commits] };
  } finally {
    await sandbox.close();
  }
}

function currentGitBranch(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}
