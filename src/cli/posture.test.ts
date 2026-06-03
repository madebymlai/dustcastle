import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { logPosture, logSweep, type PreparedPosture } from "./posture.js";

const prepared = {
  provisioned: { mode: "proot" },
  ecosystems: [
    {
      detection: { ecosystem: "node", toolchainVersion: "20.18.1" },
      provisioned: { toolchainStorePath: "/nix/store/node-toolchain" },
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
      {
        level: "info",
        fields: {
          event: "swept",
          line: "1700000000000 last sweep freed 4300 bytes (2 path(s) collected)",
          sweptAt: 1700000000000,
          freedBytes: 4300,
          pathsCollected: 2,
        },
        msg: "swept",
        args: [],
      },
      // The posture is no longer one banner event — each unique fact is its own line.
      // Egress is intentionally absent: `proxy enforcing allowlist` already prints it.
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
      note: "(sandbox provisioned and ready; run `dustcastle model` to choose an agent model)",
    });

    expect(logger.records.map((r) => r.msg)).toEqual([
      "store provisioned (rootless nix-portable)",
      "node toolchain ready",
      "(sandbox provisioned and ready; run `dustcastle model` to choose an agent model)",
    ]);
    expect(logger.records.some((r) => r.msg === "agent ready")).toBe(false);
  });
});
