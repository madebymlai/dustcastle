import { describe, expect, it } from "vitest";
import { ensureBeads } from "./beads.js";

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
