import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  branchForIssue,
  completedFrom,
  implementArgs,
  mergeArgs,
  phaseConfig,
  reviewArgs,
  worktreeCopies,
} from "./orchestrate.js";
import type { IssueOutcome } from "./orchestrate.js";
import type { PlannedIssue } from "./plan-schema.js";

function issue(id: string): PlannedIssue {
  return { id, title: `Issue ${id}`, branch: branchForIssue(id) };
}
import { loadOrchestrationPrompt } from "../agent/prompts.js";

describe("branchForIssue", () => {
  it("is the deterministic sandcastle/issue-{id} branch name", () => {
    expect(branchForIssue("42")).toBe("sandcastle/issue-42");
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
    expect(worktreeCopies(proj("CONTEXT.md", "AGENTS.md"))).toEqual([
      ".beads",
      "CONTEXT.md",
      "AGENTS.md",
    ]);
  });

  it("never lists a context doc the project doesn't have (no missing-path copy)", () => {
    const copies = worktreeCopies(proj("AGENTS.md"));
    expect(copies).toContain("AGENTS.md");
    expect(copies).not.toContain("CONTEXT.md");
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

describe("completedFrom", () => {
  it("keeps only fulfilled issues that committed, preserving order", () => {
    const results: PromiseSettledResult<IssueOutcome>[] = [
      { status: "fulfilled", value: { issue: issue("1"), commits: [{ sha: "a" }] } },
      { status: "fulfilled", value: { issue: issue("2"), commits: [] } },
      { status: "rejected", reason: new Error("boom") },
      { status: "fulfilled", value: { issue: issue("3"), commits: [{ sha: "b" }] } },
    ];
    expect(completedFrom(results).map((i) => i.id)).toEqual(["1", "3"]);
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
