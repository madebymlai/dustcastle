import { describe, expect, it, vi } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { spawnAutoGc } from "./autogc.js";

// The detached-spawn helper (ADR 0007). The orchestration is exercised in
// store/autogc.test.ts; here we only pin the child invocation — `node <cli> __autogc`,
// detached + unref'd so the parent run exits immediately — and its best-effort skips.

describe("spawnAutoGc (the detached one-shot launcher)", () => {
  it("spawns `node <cliEntry> __autogc` detached, then unrefs it", () => {
    const unref = vi.fn();
    const spawnFn = vi.fn(() => ({ unref }) as never);

    spawnAutoGc({ cliEntry: "/opt/dustcastle/main.js", spawnFn });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args, options] = spawnFn.mock.calls[0]! as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual(["/opt/dustcastle/main.js", "__autogc"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("skips silently when the CLI entry cannot be located (best-effort)", () => {
    const spawnFn = vi.fn();
    spawnAutoGc({ cliEntry: "", spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("swallows a spawn failure as a surfaced warning (never throws)", () => {
    const root = createMemoryLogger();
    const logger = root.child({ mod: "gc" });
    const spawnFn = vi.fn(() => {
      throw new Error("no exec");
    });
    expect(() =>
      spawnAutoGc({ cliEntry: "/x.js", spawnFn, logger }),
    ).not.toThrow();
    expect(root.records).toContainEqual({
      level: "warn",
      fields: { mod: "gc", err: "no exec" },
      msg: "could not spawn autogc child",
      args: [],
    });
  });
});
