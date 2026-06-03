import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "./fake.js";
import { noopLogger } from "./index.js";

describe("noopLogger", () => {
  it("is callable at every level and children stay noop", () => {
    expect(() => {
      noopLogger.fatal({ x: 1 }, "fatal");
      noopLogger.error("error");
      noopLogger.warn("warn");
      noopLogger.info("info");
      noopLogger.debug("debug");
      noopLogger.trace("trace");
      noopLogger.child({ mod: "x" }).info({ y: 2 }, "child");
    }).not.toThrow();
  });
});

describe("createMemoryLogger", () => {
  it("collects records with child bindings merged as structured fields", () => {
    const root = createMemoryLogger();
    const log = root.child({ mod: "orchestrate" });

    log.info({ loop: 1, maxLoops: 10 }, "planning");
    log.warn("no commits");

    expect(root.records).toEqual([
      { level: "info", fields: { mod: "orchestrate", loop: 1, maxLoops: 10 }, msg: "planning", args: [] },
      { level: "warn", fields: { mod: "orchestrate" }, msg: "no commits", args: [] },
    ]);
  });
});
