import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { logHostPosture, logPosture, logSweep, type PreparedPosture } from "./posture.js";

const prepared = {
  ecosystems: [
    {
      detection: { ecosystem: "node", toolchainVersion: "20.18.1" },
      provisioned: { mode: "proot", toolchainStorePath: "/nix/store/node-toolchain" },
    },
  ],
} satisfies PreparedPosture;

describe("posture logging", () => {
  it("emits the sweep line and the posture as one ordinary line per unique fact", () => {
    const logger = createMemoryLogger();

    logSweep(logger, "1700000000000 last sweep freed 4300 bytes (2 path(s) collected)");
    logPosture(logger, prepared, {
      agent: { runner: "pi", model: "openai/gpt-4.1", mount: "~/.pi/agent" },
    });

    expect(logger.records).toEqual([
      // The sweep is an ordinary line now (no 🧹 renderer): a self-contained message,
      // with the parsed numbers as fields for the flight recorder.
      {
        level: "info",
        fields: { freedBytes: 4300, pathsCollected: 2, sweptAt: 1700000000000 },
        msg: "last GC sweep freed 4300 bytes (2 path(s) collected)",
        args: [],
      },
      // The posture is no longer one banner event — each unique fact is its own line.
      {
        level: "info",
        fields: { mode: "proot" },
        msg: "store provisioned (rootless nix-portable)",
        args: [],
      },
      {
        level: "info",
        fields: { version: "20.18.1", storePath: "/nix/store/node-toolchain" },
        msg: "node toolchain ready",
        args: [],
      },
      {
        level: "info",
        fields: { runner: "pi", model: "openai/gpt-4.1", mount: "~/.pi/agent" },
        msg: "agent ready",
        args: [],
      },
    ]);
  });

  it("omits the agent line when no agent runs, and emits the note as a bare message", () => {
    const logger = createMemoryLogger();
    logPosture(logger, prepared, {
      note: "(sandbox provisioned and ready; run `dustcastle config` to choose an agent model)",
    });

    expect(logger.records.map((r) => r.msg)).toEqual([
      "store provisioned (rootless nix-portable)",
      "node toolchain ready",
      "(sandbox provisioned and ready; run `dustcastle config` to choose an agent model)",
    ]);
    expect(logger.records.some((r) => r.msg === "agent ready")).toBe(false);
  });

  it("surfaces an unparseable gc.log sweep line verbatim rather than dropping it", () => {
    const logger = createMemoryLogger();
    logSweep(logger, "garbled gc line");

    expect(logger.records).toEqual([
      { level: "info", fields: {}, msg: "last GC sweep: garbled gc line", args: [] },
    ]);
  });
});

describe("host posture logging", () => {
  it("emits a warn-level no-isolation line and an info-level agent ready line", () => {
    const logger = createMemoryLogger();
    logHostPosture(logger, { runner: "pi", model: "openai/gpt-4.1", mount: "~/.pi/agent" });

    expect(logger.records).toEqual([
      {
        level: "warn",
        fields: {},
        msg: "agents act directly on the host with no isolation",
        args: [],
      },
      {
        level: "info",
        fields: { runner: "pi", model: "openai/gpt-4.1", mount: "~/.pi/agent" },
        msg: "agent ready",
        args: [],
      },
    ]);
  });

});
