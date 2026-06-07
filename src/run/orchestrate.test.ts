import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  reviewArgs,
  worktreeCopies,
} from "./orchestrate.js";
import type { IssueOutcome, OrchestrateDeps } from "./orchestrate.js";
import type { ReadyIssue } from "./beads.js";
import { loadOrchestrationPrompt } from "../agent/prompts.js";

function issue(id: string): ReadyIssue {
  return { id, title: `Issue ${id}`, branch: branchForIssue(id) };
}

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
      implementArgs({ id: "42", title: "Fix auth bug", branch: "sandcastle/issue-42" }),
    ).toEqual({
      TASK_ID: "42",
      ISSUE_TITLE: "Fix auth bug",
      BRANCH: "sandcastle/issue-42",
    });
  });
});

describe("reviewArgs", () => {
  it("passes both the branch and the base branch to the review prompt", () => {
    expect(
      reviewArgs(
        { id: "42", title: "Fix auth bug", branch: "sandcastle/issue-42" },
        "main",
      ),
    ).toEqual({
      BRANCH: "sandcastle/issue-42",
      BASE_BRANCH: "main",
    });
  });
});

describe("mergeArgs", () => {
  it("renders the completed branches and issues as markdown lists", () => {
    expect(
      mergeArgs([
        { id: "42", title: "Fix auth bug", branch: "sandcastle/issue-42" },
        { id: "7", title: "Add logging", branch: "sandcastle/issue-7" },
      ]),
    ).toEqual({
      BRANCHES: "- sandcastle/issue-42\n- sandcastle/issue-7",
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
      bdReady: () => [issue("42")],
      run: async (args) => {
        runNames.push(String(args.name));
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

    expect(runNames).toEqual(["Merger"]);
    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "orchestrate", event: "ready_pull", loop: 1, maxLoops: 1 },
        msg: "pulling Ready set",
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
      bdReady: () => [],
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
        fields: { mod: "orchestrate", event: "ready_pull", loop: 1, maxLoops: 1 },
        msg: "pulling Ready set",
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
      bdReady: () => [],
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
        fields: { mod: "orchestrate", event: "ready_pull", loop: 1, maxLoops: 1 },
        msg: "pulling Ready set",
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
      bdReady: () => [],
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
        fields: { mod: "orchestrate", event: "ready_pull", loop: 1, maxLoops: 1 },
        msg: "pulling Ready set",
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

describe("orchestrate bdReady-driven loop", () => {
  it("propagates a bdReady failure instead of swallowing it", async () => {
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
      bdReady: () => {
        throw new Error("bd exited 1");
      },
    };

    await expect(
      orchestrate({
        cwd: "/repo",
        maxLoops: 1,
        beads: { hasBdBinary: () => true, beadsDirExists: () => true },
        deps,
      }),
    ).rejects.toThrow("bd exited 1");
  });

  it("re-pulls across loops — a second bdReady call picks up newly-unblocked issues", async () => {
    const readyCalls: number[] = [];
    const deps: Partial<OrchestrateDeps> = {
      loadModelSelection: () => ({ model: "test/model" }),
      buildPiAgent: () => ({}) as ReturnType<OrchestrateDeps["buildPiAgent"]>,
      currentGitBranch: () => "main",
      branchAheadOf: () => false, // nothing merges
      withProvisionedSandbox: async (_opts, body) =>
        body({
          provider: {},
          prepared: {},
          withSetupHooks: () => ({}),
        } as Parameters<Parameters<OrchestrateDeps["withProvisionedSandbox"]>[1]>[0]),
      bdReady: () => {
        readyCalls.push(readyCalls.length);
        // Loop 1: two issues; loop 2: empty (idle).
        if (readyCalls.length === 1) return [issue("1"), issue("2")];
        return [];
      },
      createSandbox: async () => ({
        run: async () => ({ commits: [] }),
        close: async () => {},
      }),
    };

    await orchestrate({
      cwd: "/repo",
      maxLoops: 3,
      beads: { hasBdBinary: () => true, beadsDirExists: () => true },
      logger: createMemoryLogger().child({ mod: "orchestrate" }),
      deps,
    });

    // Proves the loop re-pulls: two calls to bdReady (loop 1 with issues, loop 2 empty).
    expect(readyCalls).toEqual([0, 1]);
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
    expect(branchAheadOf(dir, "main", "sandcastle/issue-nope")).toBe(false); // unborn → fail-safe
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
      bdReady: () => [issue("42")],
      run: async (args) => {
        runNames.push(String(args.name));
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
      bdReady: () => [issue("42")],
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

describe("phaseConfig", () => {
  it("gives each phase its iteration budget; no plan phase remains", () => {
    expect(phaseConfig("implement")).toEqual({ maxIterations: 100 });
    expect(phaseConfig("review")).toEqual({ maxIterations: 1 });
    expect(phaseConfig("merge")).toEqual({ maxIterations: 1 });
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

  it("never uses sandcastle's reserved auto-injected branch placeholders", () => {
    // Passing {{SOURCE_BRANCH}} / {{TARGET_BRANCH}} in promptArgs is an error —
    // sandcastle injects them itself. We deliberately use our own {{BASE_BRANCH}}.
    const reserved = new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]);
    for (const phase of ["implement", "review", "merge"] as const) {
      for (const key of placeholders(loadOrchestrationPrompt(phase))) {
        expect(reserved.has(key)).toBe(false);
      }
    }
  });
});

describe("loadOrchestrationPrompt", () => {
  it("loads each bundled phase prompt with its beads commands and placeholders", () => {
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
