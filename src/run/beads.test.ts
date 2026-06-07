import { describe, expect, it } from "vitest";
import { branchForIssue, ensureBeads, mapReadyIssues } from "./beads.js";

describe("branchForIssue", () => {
  it("is the deterministic sandcastle/issue-{id} branch name", () => {
    expect(branchForIssue("42")).toBe("sandcastle/issue-42");
    expect(branchForIssue("dustcastle-14p")).toBe("sandcastle/issue-dustcastle-14p");
  });
});

describe("mapReadyIssues", () => {
  it("maps each bd ready row to a ReadyIssue with a deterministic branch", () => {
    const parsed = [
      { id: "42", title: "Fix auth bug" },
      { id: "dustcastle-14p", title: "Deps cache fingerprint workspace regression" },
    ];
    expect(mapReadyIssues(parsed)).toEqual([
      { id: "42", title: "Fix auth bug", branch: "sandcastle/issue-42" },
      { id: "dustcastle-14p", title: "Deps cache fingerprint workspace regression", branch: "sandcastle/issue-dustcastle-14p" },
    ]);
  });

  it("returns an empty array when bd ready returns no rows", () => {
    expect(mapReadyIssues([])).toEqual([]);
  });

  it("rejects non-array input (malformed JSON)", () => {
    expect(() => mapReadyIssues({ issues: [] })).toThrow(/expected an array/);
    expect(() => mapReadyIssues(null)).toThrow(/expected an array/);
    expect(() => mapReadyIssues("nope")).toThrow(/expected an array/);
  });

  it("rejects a row that is not an object", () => {
    expect(() => mapReadyIssues(["nope"])).toThrow(/expected an array of objects/);
  });

  it("rejects a row missing an id", () => {
    expect(() => mapReadyIssues([{ title: "no id" }])).toThrow(/missing id/);
  });
});

describe("ensureBeads", () => {
  it("passes when bd is available and .beads exists", () => {
    expect(() =>
      ensureBeads({ hasBdBinary: () => true, beadsDirExists: () => true }),
    ).not.toThrow();
  });

  it("fails with an actionable error when bd is missing", () => {
    expect(() =>
      ensureBeads({ hasBdBinary: () => false, beadsDirExists: () => true }),
    ).toThrow(/bd/);
  });

  it("fails with an actionable error when .beads is missing", () => {
    expect(() =>
      ensureBeads({ hasBdBinary: () => true, beadsDirExists: () => false }),
    ).toThrow(/\.beads/);
  });
});
