import { describe, expect, it } from "vitest";
import { planSchema } from "./plan-schema.js";

describe("planSchema", () => {
  it("accepts a well-formed plan of unblocked issues", () => {
    const parsed = planSchema.parse({
      issues: [{ id: "42", title: "Fix auth bug", branch: "sandcastle/issue-42" }],
    });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toEqual({
      id: "42",
      title: "Fix auth bug",
      branch: "sandcastle/issue-42",
    });
  });

  it("accepts an empty plan (nothing to do)", () => {
    expect(planSchema.parse({ issues: [] }).issues).toEqual([]);
  });

  it("rejects an issue missing a required field", () => {
    expect(() => planSchema.parse({ issues: [{ id: "42", title: "x" }] })).toThrow();
  });
});
