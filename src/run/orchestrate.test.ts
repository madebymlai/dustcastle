import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import {
  branchAheadOf,
  branchForIssue,
  completedFrom,
  implementArgs,
  MERGE_ATTEMPTS,
  mergeArgs,
  orchestrate,
  phaseConfig,
  PLANNER_ATTEMPTS,
  reviewArgs,
  worktreeCopies,
} from "./orchestrate.js";
import type { IssueOutcome, OrchestrateDeps } from "./orchestrate.js";
import type { PlannedIssue } from "./plan-schema.js";

function issue(id: string): PlannedIssue {
  return { id, title: `Issue ${id}`, branch: branchForIssue(id) };
}
import { loadOrchestrationPrompt } from "../agent/prompts.js";

// A real repo whose `main` has one commit and whose deterministic per-issue `branch`
// carries an EXTRA, unmerged commit — the "stranded" state an interrupted earlier loop
// leaves behind (the worker committed, but the merge never landed). The caller owns
// cleanup of the returned dir.
function repoWithStrandedBranch(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-strand-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "base.txt"), "base");
  git("add", ".");
  git("commit", "-qm", "base");
  git("switch", "-qc", branch);
  writeFileSync(join(dir, "work.txt"), "work");
  git("add", ".");
  git("commit", "-qm", "stranded work from a prior loop");
  git("switch", "-q", "main");
  return dir;
}

describe("branchForIssue", () => {
  it("is the deterministic dustcastle/issue-{id} branch name", () => {
    expect(branchForIssue("42")).toBe("dustcastle/issue-42");
  });
});

describe("worktreeCopies (what the per-issue worktree carries past the git checkout)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });
  const proj = (...files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-wt-"));
    tmps.push(dir);
    for (const f of files) writeFileSync(join(dir, f), "x");
    return dir;
  };

  it("always carries .beads (its Dolt DB is git-excluded)", () => {
    expect(worktreeCopies(proj())).toEqual([".beads"]);
  });

  it("adds the agent-context docs that exist at the project root", () => {
    expect(worktreeCopies(proj("CONTEXT.md", "CODING_STANDARDS.md"))).toEqual([
      ".beads",
      "CONTEXT.md",
      "CODING_STANDARDS.md",
    ]);
  });

  it("never copies AGENTS.md (intentionally excluded)", () => {
    expect(worktreeCopies(proj("AGENTS.md"))).toEqual([".beads"]);
  });

  it("never lists a context doc the project doesn't have (no missing-path copy)", () => {
    const copies = worktreeCopies(proj("CONTEXT.md"));
    expect(copies).toContain("CONTEXT.md");
    expect(copies).not.toContain("CODING_STANDARDS.md");
  });
});

describe("implementArgs", () => {
  it("maps an issue to the implement prompt's placeholders", () => {
    expect(
      implementArgs({ id: "42", title: "Fix auth bug", branch: "dustcastle/issue-42" }),
    ).toEqual({
      TASK_ID: "42",
      ISSUE_TITLE: "Fix auth bug",
      BRANCH: "dustcastle/issue-42",
    });
  });
});

describe("reviewArgs", () => {
  it("passes both the branch and the base branch to the review prompt", () => {
    expect(
      reviewArgs(
        { id: "42", title: "Fix auth bug", branch: "dustcastle/issue-42" },
        "main",
      ),
    ).toEqual({
      BRANCH: "dustcastle/issue-42",
      BASE_BRANCH: "main",
    });
  });
});

describe("mergeArgs", () => {
  it("renders the completed branches and issues as markdown lists", () => {
    expect(
      mergeArgs([
        { id: "42", title: "Fix auth bug", branch: "dustcastle/issue-42" },
        { id: "7", title: "Add logging", branch: "dustcastle/issue-7" },
      ]),
    ).toEqual({
      BRANCHES: "- dustcastle/issue-42\n- dustcastle/issue-7",
      ISSUES: "- 42: Fix auth bug\n- 7: Add logging",
    });
  });
});

describe("orchestrate logging", () => {
  it("emits structured loop records through the caller-named child logger", async () => {
    const root = createMemoryLogger();
    const runNames: string[] = [];
    let merged = false;
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      // The branch is ahead (mergeable) until the Merger lands it; modelling that
      // transition lets the post-merge verification see a clean, single-shot merge.
      branchAheadOf: () => !merged,
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      run: async (args) => {
        runNames.push(String(args.name));
        if (args.name === "Planner") return { output: { issues: [issue("42")] } };
        if (args.name === "Merger") merged = true;
        return { output: { issues: [] } };
      },
      createSandbox: async () => ({
        run: async (args) => ({ commits: args.name === "Worker" ? [{ sha: "a" }] : [{ sha: "b" }] }),
        close: async () => {},
      }),
    };

    await orchestrate({
      cwd: "/repo",
      maxLoops: 1,
      beads: { hasBdBinary: () => true, beadsDirExists: () => true },
      logger: root.child({ mod: "orchestrate" }),
      deps,
    });

    expect(runNames).toEqual(["Planner", "Merger"]);
    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "orchestrate", event: "planning", loop: 1, maxLoops: 1 },
        msg: "planning",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "orchestrate", event: "implement_review", loop: 1, issueCount: 1 },
        msg: "implement + review",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "orchestrate", event: "merge", loop: 1, completedCount: 1 },
        msg: "merging branches",
        args: [],
      },
    ]);
  });

  it("reaps close-eligible epics, logging the reap before declaring idle", async () => {
    const root = createMemoryLogger();
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      run: async () => ({ output: { issues: [] } }),
      closeEligibleEpics: () => ({ closed: ["dustcastle-9lx"], count: 1 }),
    };

    await orchestrate({
      cwd: "/repo",
      maxLoops: 1,
      beads: { hasBdBinary: () => true, beadsDirExists: () => true },
      logger: root.child({ mod: "orchestrate" }),
      deps,
    });

    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "orchestrate", event: "planning", loop: 1, maxLoops: 1 },
        msg: "planning",
        args: [],
      },
      {
        level: "info",
        fields: {
          mod: "orchestrate",
          event: "epic_close_eligible",
          closed: "dustcastle-9lx",
          count: 1,
        },
        msg: "reaped finished epics",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "orchestrate", event: "idle", loop: 1, maxLoops: 1 },
        msg: "nothing left to do",
        args: [],
      },
    ]);
  });

  it("stays quiet about the reap when nothing was close-eligible (no count:0 noise)", async () => {
    const root = createMemoryLogger();
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      run: async () => ({ output: { issues: [] } }),
      closeEligibleEpics: () => ({ closed: [], count: 0 }),
    };

    await orchestrate({
      cwd: "/repo",
      maxLoops: 1,
      beads: { hasBdBinary: () => true, beadsDirExists: () => true },
      logger: root.child({ mod: "orchestrate" }),
      deps,
    });

    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "orchestrate", event: "planning", loop: 1, maxLoops: 1 },
        msg: "planning",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "orchestrate", event: "idle", loop: 1, maxLoops: 1 },
        msg: "nothing left to do",
        args: [],
      },
    ]);
  });

  it("warns and still declares idle when the reap fails (a reap hiccup never fails a finished run)", async () => {
    const root = createMemoryLogger();
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      run: async () => ({ output: { issues: [] } }),
      closeEligibleEpics: () => {
        throw new Error("bd exited 1");
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads: { hasBdBinary: () => true, beadsDirExists: () => true },
        logger: root.child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "orchestrate", event: "planning", loop: 1, maxLoops: 1 },
        msg: "planning",
        args: [],
      },
      {
        level: "warn",
        fields: { mod: "orchestrate", event: "epic_reap_failed", err: "bd exited 1" },
        msg: "epic reap failed; leaving epics for the next run",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "orchestrate", event: "idle", loop: 1, maxLoops: 1 },
        msg: "nothing left to do",
        args: [],
      },
    ]);
  });
});

describe("completedFrom", () => {
  it("keeps fulfilled, mergeable issues; drops rejected and non-ahead branches, preserving order", () => {
    const results: PromiseSettledResult<IssueOutcome>[] = [
      { status: "fulfilled", value: { issue: issue("1") } },
      { status: "fulfilled", value: { issue: issue("2") } },
      { status: "rejected", reason: new Error("boom") },
      { status: "fulfilled", value: { issue: issue("3") } },
    ];
    // Branch 2 is not ahead of the target (nothing to merge); 1 and 3 are.
    const ahead = new Set(["1", "3"]);
    expect(
      completedFrom(results, (i) => ahead.has(i.id)).map((i) => i.id),
    ).toEqual(["1", "3"]);
  });
});

describe("orchestrate merge gate (regression: a branch left ahead by a prior loop must still merge)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });
  const strandedRepo = (branch: string): string => {
    const dir = repoWithStrandedBranch(branch);
    tmps.push(dir);
    return dir;
  };

  it("branchAheadOf: true only when the branch carries commits not in the target", () => {
    const branch = branchForIssue("42");
    const dir = strandedRepo(branch);
    expect(branchAheadOf(dir, "main", branch)).toBe(true); // a prior loop's commit
    expect(branchAheadOf(dir, "main", "main")).toBe(false); // nothing ahead of itself
    expect(branchAheadOf(dir, "main", "dustcastle/issue-nope")).toBe(false); // unborn → fail-safe
  });

  it("merges the stranded branch even when this loop's worker produces no new commits", async () => {
    const dir = strandedRepo(branchForIssue("42"));
    const runNames: string[] = [];
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      run: async (args) => {
        runNames.push(String(args.name));
        if (args.name === "Planner") return { output: { issues: [issue("42")] } };
        // The Merger lands the stranded branch into main (the post-merge verification
        // then sees a clean, single-shot merge — no retry).
        if (args.name === "Merger") {
          execFileSync("git", ["merge", "--ff-only", branchForIssue("42")], {
            cwd: dir,
            stdio: "ignore",
          });
        }
        return { output: { issues: [] } };
      },
      // The worker finds the work already on the branch and commits nothing new.
      createSandbox: async () => ({
        run: async () => ({ commits: [] }),
        close: async () => {},
      }),
    };

    await orchestrate({
      cwd: dir,
      targetBranch: "main",
      maxLoops: 1,
      beads: { hasBdBinary: () => true, beadsDirExists: () => true },
      logger: createMemoryLogger().child({ mod: "orchestrate" }),
      deps,
    });

    // The branch carries an unmerged commit, so the merge phase MUST run — the
    // earlier bug skipped it because the worker produced no commits THIS loop.
    expect(runNames).toContain("Merger");
  });
});

describe("orchestrate merge verification (Bug B: a Merger that no-ops must not pass for success)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });
  const strandedRepo = (branch: string): string => {
    const dir = repoWithStrandedBranch(branch);
    tmps.push(dir);
    return dir;
  };

  // The orchestrate seams these tests share. branchAheadOf is DELIBERATELY not stubbed —
  // the real one runs against the temp repo, so "did the merge land?" is answered by git,
  // not a mock. Each test supplies its own `run` to model how the Merger (mis)behaves.
  function baseDeps(): Partial<OrchestrateDeps> {
    return {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      // The worker finds the work already on the stranded branch and commits nothing new.
      createSandbox: async () => ({
        run: async () => ({ commits: [] }),
        close: async () => {},
      }),
    };
  }

  const beads = { hasBdBinary: () => true, beadsDirExists: () => true };

  it("detects a Merger that never lands the branch, retries, then surfaces it loudly — no silent no-op", async () => {
    const branch = branchForIssue("42");
    const dir = strandedRepo(branch);
    const root = createMemoryLogger();
    let mergerCalls = 0;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") return { output: { issues: [issue("42")] } };
        if (args.name === "Merger") mergerCalls++; // no-op: the branch never lands
        return { output: { issues: [] } };
      },
    };

    await expect(
      orchestrate({
        cwd: dir,
        targetBranch: "main",
        maxLoops: 1,
        beads,
        logger: root.child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    expect(mergerCalls).toBe(MERGE_ATTEMPTS); // verified and retried, not trusted once
    expect(
      root.records.some((r) => r.level === "error" && r.fields.event === "merge_unlanded"),
    ).toBe(true);
    // The branch is still ahead of main — left for the merge gate to retry on a later run.
    expect(branchAheadOf(dir, "main", branch)).toBe(true);
  });

  it("stops retrying as soon as the branch lands, without surfacing a failure", async () => {
    const branch = branchForIssue("42");
    const dir = strandedRepo(branch);
    const root = createMemoryLogger();
    let mergerCalls = 0;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") return { output: { issues: [issue("42")] } };
        if (args.name === "Merger") {
          mergerCalls++;
          if (mergerCalls === 2) {
            execFileSync("git", ["merge", "--ff-only", branch], { cwd: dir, stdio: "ignore" });
          }
        }
        return { output: { issues: [] } };
      },
    };

    await orchestrate({
      cwd: dir,
      targetBranch: "main",
      maxLoops: 1,
      beads,
      logger: root.child({ mod: "orchestrate" }),
      deps,
    });

    expect(mergerCalls).toBe(2); // failed once, landed on the retry
    expect(
      root.records.some((r) => r.level === "warn" && r.fields.event === "merge_retry"),
    ).toBe(true);
    expect(root.records.some((r) => r.fields.event === "merge_unlanded")).toBe(false);
    expect(branchAheadOf(dir, "main", branch)).toBe(false); // it actually landed
  });

  it("merges in one shot when the Merger lands the branch immediately (no spurious retry)", async () => {
    const branch = branchForIssue("42");
    const dir = strandedRepo(branch);
    const root = createMemoryLogger();
    let mergerCalls = 0;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") return { output: { issues: [issue("42")] } };
        if (args.name === "Merger") {
          mergerCalls++;
          execFileSync("git", ["merge", "--ff-only", branch], { cwd: dir, stdio: "ignore" });
        }
        return { output: { issues: [] } };
      },
    };

    await orchestrate({
      cwd: dir,
      targetBranch: "main",
      maxLoops: 1,
      beads,
      logger: root.child({ mod: "orchestrate" }),
      deps,
    });

    expect(mergerCalls).toBe(1);
    expect(
      root.records.some(
        (r) => r.fields.event === "merge_retry" || r.fields.event === "merge_unlanded",
      ),
    ).toBe(false);
  });
});

describe("orchestrate planner resilience (Bug A: a malformed <plan> must not crash the run)", () => {
  // Sandcastle rejects a malformed <plan> with StructuredOutputError, exactly as the
  // library does at runtime; the optional sessionId is what makes the documented
  // resume-with-feedback recovery possible.
  function planParseError(sessionId?: string): sandcastle.StructuredOutputError {
    return new sandcastle.StructuredOutputError(
      "Structured output tag <plan> contains invalid JSON",
      {
        tag: "plan",
        rawMatched: "{ not json",
        commits: [],
        branch: "main",
        ...(sessionId !== undefined ? { sessionId } : {}),
      },
    );
  }

  // The orchestrate seams every Bug-A test shares; each test supplies its own `run`.
  function baseDeps(): Partial<OrchestrateDeps> {
    return {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      branchAheadOf: () => true,
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      createSandbox: async () => ({
        run: async () => ({ commits: [{ sha: "a" }] }),
        close: async () => {},
      }),
    };
  }

  const beads = { hasBdBinary: () => true, beadsDirExists: () => true };

  it("recovers a malformed <plan> by resuming the planner session with feedback, then continues", async () => {
    const plannerArgs: Record<string, unknown>[] = [];
    const runNames: string[] = [];
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        runNames.push(String(args.name));
        if (args.name === "Planner") {
          plannerArgs.push(args);
          if (plannerArgs.length === 1) throw planParseError("sess-1");
          return { output: { issues: [issue("42")] } };
        }
        return { output: { issues: [] } };
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads,
        logger: createMemoryLogger().child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    // Recovered on the resume — not a blind re-plan: same session + inline corrective
    // prompt, with promptFile dropped (it is mutually exclusive with prompt) and the
    // structured-output definition kept so the resumed plan is re-validated.
    expect(plannerArgs).toHaveLength(2);
    expect(plannerArgs[1]).toMatchObject({ resumeSession: "sess-1" });
    expect(plannerArgs[1]!.promptFile).toBeUndefined();
    expect(String(plannerArgs[1]!.prompt)).toContain("<plan>");
    expect(plannerArgs[1]!.output).toBe(plannerArgs[0]!.output);
    expect(runNames).toContain("Merger"); // the run proceeded normally after recovery
  });

  it("stops the run gracefully after exhausting planner retries — never crashes, never reaps", async () => {
    const root = createMemoryLogger();
    let plannerCalls = 0;
    let reaped = false;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") {
          plannerCalls++;
          throw planParseError(`sess-${plannerCalls}`);
        }
        return { output: { issues: [] } };
      },
      closeEligibleEpics: () => {
        reaped = true;
        return { closed: [], count: 0 };
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 3,
        beads,
        logger: root.child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    // Bounded retries within the one loop, then stop — NOT maxLoops × attempts, and
    // NOT an idle-reap (an unparseable plan is not evidence the work is finished).
    expect(plannerCalls).toBe(PLANNER_ATTEMPTS);
    expect(reaped).toBe(false);
    expect(
      root.records.some((r) => r.level === "error" && r.fields.event === "planner_failed"),
    ).toBe(true);
  });

  it("gives up immediately (no blind re-plan) when the rejected output has no resumable session", async () => {
    let plannerCalls = 0;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") {
          plannerCalls++;
          throw planParseError(); // no sessionId ⇒ nothing to resume
        }
        return { output: { issues: [] } };
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads,
        logger: createMemoryLogger().child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    expect(plannerCalls).toBe(1); // cannot resume, so no retry — but no crash either
  });

  it("stops gracefully when the session resume itself fails — recovery never crashes the run", async () => {
    // The first planner output is rejected WITH a sessionId, so recovery tries to resume;
    // but sandcastle's resume precheck throws a plain Error (e.g. the session was never
    // captured to host). That must degrade to a clean stop, not propagate as a crash.
    const root = createMemoryLogger();
    let plannerCalls = 0;
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") {
          plannerCalls++;
          if (args.resumeSession !== undefined) {
            throw new Error(`resumeSession "${String(args.resumeSession)}" not found`);
          }
          throw planParseError("sess-1");
        }
        return { output: { issues: [] } };
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads,
        logger: root.child({ mod: "orchestrate" }),
        deps,
      }),
    ).resolves.toBeUndefined();

    expect(plannerCalls).toBe(2); // initial parse failure, then the failed resume attempt
    expect(
      root.records.some(
        (r) => r.level === "warn" && r.fields.event === "planner_resume_failed",
      ),
    ).toBe(true);
  });

  it("does not swallow a non-parse planner error — sandbox/infra failures still surface", async () => {
    const deps: Partial<OrchestrateDeps> = {
      ...baseDeps(),
      run: async (args) => {
        if (args.name === "Planner") throw new Error("sandbox vanished");
        return { output: { issues: [] } };
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads,
        logger: createMemoryLogger().child({ mod: "orchestrate" }),
        deps,
      }),
    ).rejects.toThrow("sandbox vanished");
  });
});

describe("phaseConfig", () => {
  it("gives each phase its iteration budget; only plan uses structured output", () => {
    expect(phaseConfig("plan")).toEqual({ maxIterations: 1, structuredOutput: true });
    expect(phaseConfig("implement")).toEqual({
      maxIterations: 100,
      structuredOutput: false,
    });
    expect(phaseConfig("review")).toEqual({ maxIterations: 1, structuredOutput: false });
    expect(phaseConfig("merge")).toEqual({ maxIterations: 1, structuredOutput: false });
  });
});

// Extract the set of distinct {{KEY}} placeholders in a prompt's text.
function placeholders(text: string): Set<string> {
  return new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
}

describe("promptArgs cover their prompt's placeholders exactly", () => {
  // sandcastle ERRORS on a {{KEY}} with no matching promptArg and WARNS on an
  // unused arg, so the keys a builder emits must equal the {{...}} in its prompt.
  // This guards against drift (e.g. the TARGET_BRANCH→BASE_BRANCH rename) that the
  // separate "builder keys" / "file contains" tests would each miss.
  const cases: { phase: "implement" | "review" | "merge"; keys: Set<string> }[] = [
    { phase: "implement", keys: new Set(Object.keys(implementArgs(issue("42")))) },
    { phase: "review", keys: new Set(Object.keys(reviewArgs(issue("42"), "main"))) },
    { phase: "merge", keys: new Set(Object.keys(mergeArgs([issue("42")]))) },
  ];

  for (const { phase, keys } of cases) {
    it(`${phase}: every placeholder has an arg and every arg is used`, () => {
      expect(keys).toEqual(placeholders(loadOrchestrationPrompt(phase)));
    });
  }

  it("the plan prompt takes no args (structured output only)", () => {
    expect(placeholders(loadOrchestrationPrompt("plan"))).toEqual(new Set());
  });

  it("never uses sandcastle's reserved auto-injected branch placeholders", () => {
    // Passing {{SOURCE_BRANCH}} / {{TARGET_BRANCH}} in promptArgs is an error —
    // sandcastle injects them itself. We deliberately use our own {{BASE_BRANCH}}.
    const reserved = new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]);
    for (const phase of ["plan", "implement", "review", "merge"] as const) {
      for (const key of placeholders(loadOrchestrationPrompt(phase))) {
        expect(reserved.has(key)).toBe(false);
      }
    }
  });
});

describe("loadOrchestrationPrompt", () => {
  it("loads each bundled phase prompt with its beads commands and placeholders", () => {
    const plan = loadOrchestrationPrompt("plan");
    expect(plan).toContain("bd ready");
    expect(plan).toContain("<plan>");

    const implement = loadOrchestrationPrompt("implement");
    expect(implement).toContain("{{TASK_ID}}");
    expect(implement).toContain("{{ISSUE_TITLE}}");
    expect(implement).toContain("{{BRANCH}}");
    expect(implement).toContain("bd show");

    const review = loadOrchestrationPrompt("review");
    expect(review).toContain("{{BRANCH}}");
    expect(review).toContain("{{BASE_BRANCH}}");

    const merge = loadOrchestrationPrompt("merge");
    expect(merge).toContain("{{BRANCHES}}");
    expect(merge).toContain("{{ISSUES}}");
    expect(merge).toContain("bd close");
  });
});
