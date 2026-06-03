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
  plan: { egress: { kind: "none" } },
} satisfies PreparedPosture;

describe("posture logging", () => {
  it("emits the posture banner and sweep line as structured logger events", () => {
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
      {
        level: "info",
        fields: {
          event: "provisioned",
          ecosystems: ["node"],
          mode: "proot",
          egress: { kind: "none" },
          toolchains: [{ ecosystem: "node", version: "20.18.1", storePath: "/nix/store/node-toolchain" }],
          agent: { runner: "pi", model: "openai/gpt-4.1", mount: "~/.pi/agent" },
        },
        msg: "provisioned",
        args: [],
      },
    ]);
  });
});
