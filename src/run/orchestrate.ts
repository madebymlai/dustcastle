import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { orchestrationPromptPath, type PromptPhase } from "../agent/prompts.js";
import { buildPiAgent, loadModelSelection } from "../config/global.js";
import { noopLogger, type Logger } from "../log/index.js";
import {
  closeEligibleEpics,
  ensureBeads,
  realBeadsPreflightDeps,
  type BeadsPreflightDeps,
} from "./beads.js";
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

// Agent-context docs the implement/review WORKTREE needs even when a project
// gitignores them. The worktree is a clean checkout (tracked files only), so
// gitignored/uncommitted context never lands there — `copyToWorktree` is
// sandcastle's seam to opt those in, the same one that already carries `.beads`.
const WORKTREE_CONTEXT_DOCS: readonly string[] = ["CONTEXT.md", "AGENTS.md", "CODING_STANDARDS.md"];

/**
 * What the per-issue worktree must carry beyond the git checkout: the host's live
 * `.beads` (its Dolt DB is git-excluded) plus whichever agent-context docs exist at
 * the project root (gitignored or not). Only existing paths are listed, so a project
 * without them is unaffected — we never ask sandcastle to copy a missing path.
 */
export function worktreeCopies(cwd: string): string[] {
  return [".beads", ...WORKTREE_CONTEXT_DOCS.filter((doc) => existsSync(join(cwd, doc)))];
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
  /** Structured logs for this subsystem; defaults to noop in library/deep-module use. */
  readonly logger?: Logger;
  /** Override the live sandcastle/model/provisioning seams (tests). */
  readonly deps?: Partial<OrchestrateDeps>;
}

interface PlannerResult {
  readonly output: { readonly issues: PlannedIssue[] };
}

interface PhaseResult {
  readonly commits: readonly unknown[];
}

interface IssueSandbox {
  run(args: Record<string, unknown>): Promise<PhaseResult>;
  close(): Promise<void>;
}

export interface OrchestrateDeps {
  loadModelSelection(): ReturnType<typeof loadModelSelection>;
  buildPiAgent(
    selection: NonNullable<ReturnType<typeof loadModelSelection>>,
  ): sandcastle.AgentProvider;
  currentGitBranch(cwd: string): string;
  withProvisionedSandbox<T>(
    opts: ProvisionOptions,
    body: (sandbox: ProvisionedSandbox) => Promise<T>,
  ): Promise<T>;
  run(args: Record<string, unknown>): Promise<PlannerResult>;
  createSandbox(args: Record<string, unknown>): Promise<IssueSandbox>;
  closeEligibleEpics(cwd: string): { closed: string[]; count: number };
}

const liveOrchestrateDeps: OrchestrateDeps = {
  loadModelSelection,
  buildPiAgent,
  currentGitBranch,
  withProvisionedSandbox,
  run: sandcastle.run as unknown as OrchestrateDeps["run"],
  createSandbox: sandcastle.createSandbox as unknown as OrchestrateDeps["createSandbox"],
  closeEligibleEpics,
};

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
 * copy of `.beads` and the agent-context docs (CONTEXT.md/AGENTS.md/…) via
 * `copyToWorktree` — sandcastle's seam for files a clean git checkout omits
 * (the Dolt DB is git-excluded; context docs may be gitignored).
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  ensureBeads(opts.beads ?? realBeadsPreflightDeps(opts.cwd));

  const deps: OrchestrateDeps = { ...liveOrchestrateDeps, ...opts.deps };
  const selection = deps.loadModelSelection();
  if (selection === undefined) {
    throw new Error("orchestrate: no model configured. Run `dustcastle model` first.");
  }
  const agent = deps.buildPiAgent(selection);
  const targetBranch = opts.targetBranch ?? deps.currentGitBranch(opts.cwd);
  const maxLoops = opts.maxLoops ?? DEFAULT_MAX_LOOPS;
  const logger = opts.logger ?? noopLogger;

  // `.beads` + any agent-context docs the isolated worktrees must carry past the
  // git checkout (computed once from the host project root).
  const copyToWorktree = worktreeCopies(opts.cwd);

  await deps.withProvisionedSandbox(opts, async ({ provider, withSetupHooks }) => {
    const hooks = withSetupHooks();

    for (let loop = 1; loop <= maxLoops; loop++) {
      logger.info({ event: "planning", loop, maxLoops }, "planning");
      const planned = await deps.run({
        sandbox: provider,
        agent,
        name: "Planner",
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
        // Reap epics whose children are all done before going idle — they are
        // containers the planner never picks up, so nothing else would close
        // them. A reap hiccup must not fail an otherwise-finished run, so warn
        // and leave them for the next run rather than throwing.
        try {
          const { closed, count } = deps.closeEligibleEpics(opts.cwd);
          logger.info({ event: "epic_close_eligible", closed, count }, "reaped finished epics");
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          logger.warn(
            { event: "epic_reap_failed", err },
            "epic reap failed; leaving epics for the next run",
          );
        }
        logger.info({ event: "idle", loop, maxLoops }, "nothing left to do");
        return;
      }

      logger.info(
        { event: "implement_review", loop, issueCount: issues.length },
        "implement + review",
      );
      const outcomes = await Promise.allSettled(
        issues.map((issue) =>
          executeIssue({
            issue,
            provider,
            agent,
            hooks,
            targetBranch,
            copyToWorktree,
            createSandbox: deps.createSandbox,
          }),
        ),
      );

      const completed = completedFrom(outcomes);
      if (completed.length === 0) {
        logger.info(
          { event: "skip_merge", loop, completedCount: 0 },
          "no branch produced commits; skipping merge",
        );
        continue;
      }

      logger.info(
        { event: "merge", loop, completedCount: completed.length },
        "merging branches",
      );
      await deps.run({
        sandbox: provider,
        agent,
        name: "Merger",
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
  /** `.beads` + existing agent-context docs to copy into the per-issue worktree. */
  readonly copyToWorktree: string[];
  readonly createSandbox: OrchestrateDeps["createSandbox"];
}

/**
 * One issue's implement→review pipeline in its own per-issue sandbox (a git
 * worktree off targetBranch, carrying a copy of `.beads`). The reviewer only runs
 * if the implementer committed; both share the one sandbox/branch.
 */
async function executeIssue(args: ExecuteIssueArgs): Promise<IssueOutcome> {
  const {
    issue,
    provider,
    agent,
    hooks,
    targetBranch,
    copyToWorktree,
    createSandbox,
  } = args;
  const sandbox = await createSandbox({
    sandbox: provider,
    branch: issue.branch,
    baseBranch: targetBranch,
    copyToWorktree,
    hooks,
  });
  try {
    const impl = await sandbox.run({
      agent,
      name: "Worker",
      promptFile: orchestrationPromptPath("implement"),
      promptArgs: implementArgs(issue),
      maxIterations: phaseConfig("implement").maxIterations,
    });
    if (impl.commits.length === 0) {
      return { issue, commits: [] };
    }
    const review = await sandbox.run({
      agent,
      name: "Reviewer",
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
