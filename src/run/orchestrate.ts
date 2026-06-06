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

// The result of one issue's implement→review pipeline. Merge eligibility is decided
// from the branch's state versus the target (see {@link branchAheadOf}), not from
// this loop's commit count, so the outcome carries only the issue.
export interface IssueOutcome {
  readonly issue: PlannedIssue;
}

// Of the parallel per-issue outcomes, the mergeable ones are those whose pipeline
// fulfilled (didn't throw) AND whose branch carries commits not yet in the target
// (`isMergeable`). Keying on branch-ahead-of-target rather than "committed this loop"
// is what lets a branch left ahead by an earlier, interrupted loop still merge;
// order is preserved.
export function completedFrom(
  results: readonly PromiseSettledResult<IssueOutcome>[],
  isMergeable: (issue: PlannedIssue) => boolean,
): PlannedIssue[] {
  return results
    .filter(
      (r): r is PromiseFulfilledResult<IssueOutcome> => r.status === "fulfilled",
    )
    .map((r) => r.value.issue)
    .filter(isMergeable);
}

// ── The live multi-phase loop (gated: needs a pi+bd sandbox image, a host pi
//    login, and a repo with beads issues — DUSTCASTLE_E2E on a capable host) ──

/** agentstack's MAX_ITERATIONS: plan→execute→merge cycles before stopping. */
const DEFAULT_MAX_LOOPS = 10;

/**
 * A non-deterministic planner occasionally emits a malformed `<plan>` that sandcastle
 * rejects with {@link sandcastle.StructuredOutputError} (missing tag / bad JSON / wrong
 * shape). That single bad generation must NOT kill a multi-loop run, so the planner
 * phase is attempted this many times — recovering between attempts by resuming that same
 * agent session with corrective feedback (sandcastle's documented recovery kit). A
 * resumed attempt is re-validated against the schema, so this re-asks for a WELL-FORMED
 * plan; it never accepts a malformed one.
 */
export const PLANNER_ATTEMPTS = 3;

/**
 * The Merger is a single-shot LLM agent prompted to merge the completed branches and
 * close their issues; nothing guarantees it did either. Each merge is verified against
 * the target ({@link branchAheadOf}) and re-attempted this many times before the run gives
 * up on it — a silent no-op (logging "merging branches" while `main` never advances) must
 * never pass for success.
 */
export const MERGE_ATTEMPTS = 3;

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
  branchAheadOf(cwd: string, targetBranch: string, branch: string): boolean;
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
  branchAheadOf,
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
 * copy of `.beads` and the agent-context docs (CONTEXT.md/CODING_STANDARDS.md/…) via
 * `copyToWorktree` — sandcastle's seam for files a clean git checkout omits
 * (the Dolt DB is git-excluded; context docs may be gitignored).
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<void> {
  ensureBeads(opts.beads ?? realBeadsPreflightDeps(opts.cwd));

  const deps: OrchestrateDeps = { ...liveOrchestrateDeps, ...opts.deps };
  const selection = deps.loadModelSelection();
  if (selection === undefined) {
    throw new Error("orchestrate: no model configured. Run `dustcastle config` first.");
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
      const planned = await runPlannerWithRecovery(
        deps.run,
        {
          sandbox: provider,
          agent,
          name: "Planner",
          promptFile: orchestrationPromptPath("plan"),
          maxIterations: phaseConfig("plan").maxIterations,
          output: planOutput,
          hooks,
        },
        logger,
        loop,
      );
      if (planned === undefined) {
        // Every attempt this loop produced an unparseable <plan>. Stop the run rather
        // than crash — prior loops' merges already persist — and WITHOUT reaping epics:
        // a malformed plan is not evidence the remaining work is finished. The next
        // `dustcastle run` re-plans from current beads state.
        logger.error(
          { event: "planner_failed", loop, attempts: PLANNER_ATTEMPTS },
          "planner produced no parseable <plan>; stopping",
        );
        return;
      }

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

/**
 * Run the planner, recovering from a rejected `<plan>` by resuming that same agent
 * session with corrective feedback — sandcastle ships {@link sandcastle.StructuredOutputError}
 * with `sessionId` precisely so the caller can ask the agent to re-emit valid output
 * without losing its planning context. Bounded to {@link PLANNER_ATTEMPTS}; every attempt
 * keeps the structured-output definition, so a resumed plan is re-validated (this re-asks
 * for a well-formed plan, it never accepts a malformed one). Returns undefined when no
 * attempt yielded a parseable plan, so the caller can stop the run gracefully instead of
 * crashing. A non-parse error from the FIRST (normal) planner call is the run's normal
 * error path and propagates unchanged; a non-parse error raised while RESUMING (e.g.
 * sandcastle's resume precheck when the session was never captured to host) means recovery
 * itself is unavailable, so we stop gracefully rather than let it crash the run.
 */
async function runPlannerWithRecovery(
  run: OrchestrateDeps["run"],
  plannerArgs: Record<string, unknown>,
  logger: Logger,
  loop: number,
): Promise<PlannerResult | undefined> {
  let args = plannerArgs;
  let resuming = false; // true once we are re-running via session resume (recovery)
  for (let attempt = 1; attempt <= PLANNER_ATTEMPTS; attempt++) {
    try {
      return await run(args);
    } catch (error) {
      if (!(error instanceof sandcastle.StructuredOutputError)) {
        // A non-parse failure on the FIRST (normal) planner call is the run's normal
        // error path — propagate it. The same WHILE RESUMING means our own recovery
        // could not run (e.g. sandcastle's resume precheck threw because the session was
        // never captured to host); that must never crash a run a malformed plan should
        // merely have paused, so stop gracefully instead.
        if (!resuming) throw error;
        logger.warn(
          {
            event: "planner_resume_failed",
            loop,
            err: error instanceof Error ? error.message : String(error),
          },
          "could not resume the planner session to recover; stopping",
        );
        return undefined;
      }
      logger.warn(
        {
          event: "planner_parse_failed",
          loop,
          attempt,
          maxAttempts: PLANNER_ATTEMPTS,
          err: error.message,
        },
        "planner emitted an unparseable <plan>",
      );
      // Recover only by resuming the rejected session with feedback. Without a captured
      // session there is nothing to resume, so stop rather than blindly re-plan.
      if (error.sessionId === undefined || attempt === PLANNER_ATTEMPTS) return undefined;
      // `prompt` and `promptFile` are mutually exclusive — swap the file out for the
      // inline corrective prompt and resume that session.
      const { promptFile: _promptFile, ...rest } = args;
      args = { ...rest, resumeSession: error.sessionId, prompt: plannerFeedback(error) };
      resuming = true;
    }
  }
  return undefined;
}

/**
 * The corrective prompt for a planner session resume: states exactly why the previous
 * structured output was rejected (and what it contained) and asks for a clean re-emit.
 * The literal `<tag>` must appear because sandcastle re-validates that a resumed prompt
 * names the structured-output tag when `output` is set (see RunOptions.output).
 */
function plannerFeedback(error: sandcastle.StructuredOutputError): string {
  const cause =
    error.rawMatched !== undefined
      ? `${error.message}. Your previous output contained:\n\n${error.rawMatched}`
      : error.message;
  return (
    `That response was rejected: ${cause}\n\n` +
    `Re-emit your answer as a single <${error.tag}>…</${error.tag}> block whose contents ` +
    `are valid JSON matching the required schema, and output nothing else.`
  );
}

interface MergePhaseArgs {
  readonly run: OrchestrateDeps["run"];
  readonly branchAheadOf: OrchestrateDeps["branchAheadOf"];
  readonly provider: ProvisionedSandbox["provider"];
  readonly agent: sandcastle.AgentProvider;
  readonly hooks: NonNullable<SandcastleHandoff["hooks"]>;
  readonly cwd: string;
  readonly targetBranch: string;
  readonly completed: readonly PlannedIssue[];
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
  let toMerge: readonly PlannedIssue[] = args.completed;
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
