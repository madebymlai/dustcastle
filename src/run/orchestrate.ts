import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { orchestrationPromptPath, type PromptPhase } from "../agent/prompts.js";
import { buildPiAgent, loadModelSelection } from "../config/global.js";
import { validateCredentialKeysDisjointFromAgentEnv } from "../credentials/index.js";
import { noopLogger, type Logger } from "../log/index.js";
import {
  bdReady,
  closeEligibleEpics,
  ensureBeads,
  realBeadsPreflightDeps,
  type BeadsPreflightDeps,
  type ReadyIssue,
} from "./beads.js";
import {
  withProvisionedSandbox,
  type ProvisionedSandbox,
  type ProvisionOptions,
  type SandcastleHandoff,
} from "./index.js";

export { branchForIssue } from "./beads.js";

export interface PhaseConfig {
  readonly maxIterations: number;
}

// Per-phase iteration budgets: the implementer gets a long leash;
// review/merge each run a single pass.
export function phaseConfig(phase: PromptPhase): PhaseConfig {
  switch (phase) {
    case "implement":
      return { maxIterations: 100 };
    case "review":
    case "merge":
      return { maxIterations: 1 };
  }
}

// Agent-context docs the implement/review WORKTREE needs even when a project
// gitignores them. The worktree is a clean checkout (tracked files only), so
// gitignored/uncommitted context never lands there — `copyToWorktree` is
// sandcastle's seam to opt those in, the same one that already carries `.beads`.
// AGENTS.md is intentionally excluded.
const WORKTREE_CONTEXT_DOCS: readonly string[] = ["CONTEXT.md", "CODING_STANDARDS.md"];

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
export function implementArgs(issue: ReadyIssue): Record<string, string> {
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
  issue: ReadyIssue,
  baseBranch: string,
): Record<string, string> {
  return {
    BRANCH: issue.branch,
    BASE_BRANCH: baseBranch,
  };
}

// {{...}} substitutions for the merge prompt: markdown lists of the completed
// issues' branches and their id/title, for the merger to merge and close.
export function mergeArgs(issues: readonly ReadyIssue[]): Record<string, string> {
  return {
    BRANCHES: issues.map((i) => `- ${i.branch}`).join("\n"),
    ISSUES: issues.map((i) => `- ${i.id}: ${i.title}`).join("\n"),
  };
}

// The result of one issue's implement→review pipeline. Merge eligibility is decided
// from the branch's state versus the target (see {@link branchAheadOf}), not from
// this loop's commit count, so the outcome carries only the issue.
export interface IssueOutcome {
  readonly issue: ReadyIssue;
}

// Of the parallel per-issue outcomes, the mergeable ones are those whose pipeline
// fulfilled (didn't throw) AND whose branch carries commits not yet in the target
// (`isMergeable`). Keying on branch-ahead-of-target rather than "committed this loop"
// is what lets a branch left ahead by an earlier, interrupted loop still merge;
// order is preserved.
export function completedFrom(
  results: readonly PromiseSettledResult<IssueOutcome>[],
  isMergeable: (issue: ReadyIssue) => boolean,
): ReadyIssue[] {
  return results
    .filter(
      (r): r is PromiseFulfilledResult<IssueOutcome> => r.status === "fulfilled",
    )
    .map((r) => r.value.issue)
    .filter(isMergeable);
}

// ── The live multi-phase loop (gated: needs a pi+bd sandbox image, a host pi
//    login, and a repo with beads issues — DUSTCASTLE_E2E on a capable host) ──

/** MAX_ITERATIONS: ready→execute→merge cycles before stopping. */
const DEFAULT_MAX_LOOPS = 10;

/**
 * The Merger is a single-shot LLM agent prompted to merge the completed branches and
 * close their issues; nothing guarantees it did either. Each merge is verified against
 * the target ({@link branchAheadOf}) and re-attempted this many times before the run gives
 * up on it — a silent no-op (logging "merging branches" while `main` never advances) must
 * never pass for success.
 */
export const MERGE_ATTEMPTS = 3;

export interface OrchestrateOptions extends ProvisionOptions {
  /** Max execute→merge cycles (default 10). */
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
  branchAheadOf(cwd: string, targetBranch: string, branch: string): boolean;
  withProvisionedSandbox<T>(
    opts: ProvisionOptions,
    body: (sandbox: ProvisionedSandbox) => Promise<T>,
  ): Promise<T>;
  bdReady(cwd: string): ReadyIssue[];
  run(args: Record<string, unknown>): Promise<unknown>;
  createSandbox(args: Record<string, unknown>): Promise<IssueSandbox>;
  closeEligibleEpics(cwd: string): { closed: string[]; count: number };
}

const liveOrchestrateDeps: OrchestrateDeps = {
  loadModelSelection,
  buildPiAgent,
  currentGitBranch,
  branchAheadOf,
  withProvisionedSandbox,
  bdReady,
  run: sandcastle.run as unknown as OrchestrateDeps["run"],
  createSandbox: sandcastle.createSandbox as unknown as OrchestrateDeps["createSandbox"],
  closeEligibleEpics,
};

/**
 * The deterministic Ready-set drain loop: each cycle pulls the Ready set from
 * `bd ready`, implements then reviews each issue in its own per-issue sandbox in
 * parallel, then merges the branches that landed and closes their issues. Repeats
 * so newly-unblocked issues get picked up. There is no LLM planning phase — the
 * Ready set is deterministic, drawn straight from beads.
 *
 * Implement and review run in isolated worktrees that carry a copy of `.beads`
 * and the agent-context docs (CONTEXT.md/CODING_STANDARDS.md/…) via `copyToWorktree`
 * — sandcastle's seam for files a clean git checkout omits (the Dolt DB is
 * git-excluded; context docs may be gitignored). The Merger runs on the host
 * checkout so `bd close` persists to the real `.beads`.
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  ensureBeads(opts.beads ?? realBeadsPreflightDeps(opts.cwd));

  const deps: OrchestrateDeps = { ...liveOrchestrateDeps, ...opts.deps };
  const selection = deps.loadModelSelection();
  if (selection === undefined) {
    throw new Error("orchestrate: no model configured. Run `dustcastle config` first.");
  }
  const agent = deps.buildPiAgent(selection);
  validateCredentialKeysDisjointFromAgentEnv(agent.env);
  const targetBranch = opts.targetBranch ?? deps.currentGitBranch(opts.cwd);
  const maxLoops = opts.maxLoops ?? DEFAULT_MAX_LOOPS;
  const logger = opts.logger ?? noopLogger;

  // `.beads` + any agent-context docs the isolated worktrees must carry past the
  // git checkout (computed once from the host project root).
  const copyToWorktree = worktreeCopies(opts.cwd);

  await deps.withProvisionedSandbox(opts, async ({ provider, withSetupHooks }) => {
    const hooks = withSetupHooks();

    for (let loop = 1; loop <= maxLoops; loop++) {
      logger.info({ event: "ready_pull", loop, maxLoops }, "pulling Ready set");
      const issues: ReadyIssue[] = deps.bdReady(opts.cwd);

      if (issues.length === 0) {
        // Reap epics whose children are all done before going idle — they are
        // containers that `bd ready` never returns, so nothing else would close
        // them. A reap hiccup must not fail an otherwise-finished run, so warn
        // and leave them for the next run rather than throwing.
        try {
          const { closed, count } = deps.closeEligibleEpics(opts.cwd);
          if (count > 0) {
            logger.info({ event: "epic_close_eligible", closed: closed.join(", "), count }, "reaped finished epics");
          }
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

      const completed = completedFrom(outcomes, (issue) =>
        deps.branchAheadOf(opts.cwd, targetBranch, issue.branch),
      );
      if (completed.length === 0) {
        logger.info(
          { event: "skip_merge", loop, completedCount: 0 },
          "no branch ahead of target; skipping merge",
        );
        continue;
      }

      await mergeCompleted({
        run: deps.run,
        branchAheadOf: deps.branchAheadOf,
        provider,
        agent,
        hooks,
        cwd: opts.cwd,
        targetBranch,
        completed,
        logger,
        loop,
      });
    }
  });
}

interface ExecuteIssueArgs {
  readonly issue: ReadyIssue;
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
    // The reviewer only runs if the implementer committed something to review; its
    // own commits (if any) land on the branch and are picked up by the merge gate,
    // which reads branch-ahead-of-target rather than this pipeline's return value.
    if (impl.commits.length > 0) {
      await sandbox.run({
        agent,
        name: "Reviewer",
        promptFile: orchestrationPromptPath("review"),
        promptArgs: reviewArgs(issue, targetBranch),
        maxIterations: phaseConfig("review").maxIterations,
      });
    }
    return { issue };
  } finally {
    await sandbox.close();
  }
}

interface MergePhaseArgs {
  readonly run: OrchestrateDeps["run"];
  readonly branchAheadOf: OrchestrateDeps["branchAheadOf"];
  readonly provider: ProvisionedSandbox["provider"];
  readonly agent: sandcastle.AgentProvider;
  readonly hooks: NonNullable<SandcastleHandoff["hooks"]>;
  readonly cwd: string;
  readonly targetBranch: string;
  readonly completed: readonly ReadyIssue[];
  readonly logger: Logger;
  readonly loop: number;
}

/**
 * Merge the completed branches and VERIFY each one actually landed, instead of trusting
 * the single-shot Merger agent. The Merger can fail, partially complete, or be interrupted
 * after the loop has already announced "merging branches"; a branch still ahead of the
 * target afterwards did not merge. Unlanded branches are re-merged, bounded to
 * {@link MERGE_ATTEMPTS}; any that never land are surfaced at error level — never a silent
 * no-op (the original bug). They also stay ahead of the target, so the merge gate
 * re-merges them on a later loop/run: the failure is scoped to this cycle, not the run.
 */
async function mergeCompleted(args: MergePhaseArgs): Promise<void> {
  const { run, branchAheadOf, provider, agent, hooks, cwd, targetBranch, logger, loop } =
    args;
  logger.info(
    { event: "merge", loop, completedCount: args.completed.length },
    "merging branches",
  );
  let toMerge: readonly ReadyIssue[] = args.completed;
  for (let attempt = 1; attempt <= MERGE_ATTEMPTS; attempt++) {
    await run({
      sandbox: provider,
      agent,
      name: "Merger",
      promptFile: orchestrationPromptPath("merge"),
      promptArgs: mergeArgs(toMerge),
      maxIterations: phaseConfig("merge").maxIterations,
      hooks,
    });
    // The merge-eligibility signal, reused as the merge-landed signal: a branch still
    // ahead of the target after the Merger ran did not actually merge.
    const unlanded = toMerge.filter((issue) =>
      branchAheadOf(cwd, targetBranch, issue.branch),
    );
    if (unlanded.length === 0) return;
    if (attempt < MERGE_ATTEMPTS) {
      logger.warn(
        { event: "merge_retry", loop, attempt, maxAttempts: MERGE_ATTEMPTS, unlanded: unlanded.length },
        "merge did not land; retrying the unlanded branches",
      );
    } else {
      logger.error(
        {
          event: "merge_unlanded",
          loop,
          attempts: MERGE_ATTEMPTS,
          branches: unlanded.map((i) => i.branch).join(", "),
        },
        "merge did not land after retries; branches still ahead of target (a later loop will retry)",
      );
    }
    toMerge = unlanded;
  }
}

function currentGitBranch(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/**
 * Whether `branch` carries commits not yet in `targetBranch` — the merge-eligibility
 * signal. Deterministic per-issue branch names accumulate progress ACROSS loops (see
 * {@link branchForIssue}), so the question is whether the branch is ahead of the
 * target, NOT whether the worker committed in THIS loop: a branch left ahead by an
 * earlier (interrupted) loop must still merge. An unknown/unborn branch — or any git
 * error — is "nothing to merge" (false), keeping the gate fail-safe.
 */
export function branchAheadOf(cwd: string, targetBranch: string, branch: string): boolean {
  try {
    const count = execFileSync(
      "git",
      ["rev-list", "--count", `${targetBranch}..${branch}`],
      // Capture stdout; silence stderr so the common unborn-branch case (git's
      // "fatal: ambiguous argument") doesn't spam the console — we handle it below.
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return Number(count) > 0;
  } catch {
    return false; // unknown/unborn branch — nothing to merge
  }
}
