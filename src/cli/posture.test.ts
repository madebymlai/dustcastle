import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import type { PreparedRun } from "../run/index.js";
import { logPosture, logSweep } from "./posture.js";

const prepared = {
  detection: { ecosystem: "node", packageManager: "npm" },
  provisioned: {
    mode: "proot",
    physStoreRoot: "/phys/store",
    toolchainStorePath: "/nix/store/node-toolchain",
  },
  ecosystems: [
    {
      detection: { ecosystem: "node", packageManager: "npm", toolchainVersion: "20.18.1" },
      provisioned: {
        mode: "proot",
        physStoreRoot: "/phys/store",
        toolchainStorePath: "/nix/store/node-toolchain",
      },
    },
  ],
  plan: {
    egress: { kind: "none" },
  },
} as unknown as PreparedRun;

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
