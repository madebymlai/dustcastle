import { describe, expect, it } from "vitest";
import { messageFormat } from "./format.js";

const provisioned = {
  event: "provisioned",
  ecosystems: ["node", "python"],
  mode: "bwrap",
  toolchains: [
    { ecosystem: "node", version: "20.18.1", storePath: "/nix/store/node-toolchain" },
    { ecosystem: "python", version: undefined, storePath: "/nix/store/python-toolchain" },
  ],
  egress: {
    kind: "allowlist",
    buildHosts: ["registry.npmjs.org", "pypi.org"],
    agentHosts: ["api.openai.com"],
  },
} as const;

describe("messageFormat", () => {
  it("renders provisioned events as the familiar posture banner", () => {
    expect(messageFormat(provisioned)).toBe([
      "🏖️  dustcastle: provisioned node + python",
      "    store mode : bwrap  (rootless nix-portable)",
      "    node   : 20.18.1  /nix/store/node-toolchain",
      "    python : (default)  /nix/store/python-toolchain",
      "    deps       : installed in-Sandbox",
      "    egress     : allowlist — build: [registry.npmjs.org, pypi.org]  agent: [api.openai.com]",
      "    /nix/store mounted read-only into the sandbox",
    ].join("\n"));
  });

  it("renders swept events as the next-run sweep line", () => {
    expect(messageFormat({ event: "swept", line: "1700000000000 last sweep freed 4300 bytes (2 path(s) collected)" })).toBe(
      "🧹 dustcastle: 1700000000000 last sweep freed 4300 bytes (2 path(s) collected)",
    );
  });

  it("renders ordinary records as the bare message (mod stays out of the console)", () => {
    // `mod` is implementation detail — it never reaches the console message; only msg does.
    expect(messageFormat({ mod: "gc", msg: "collecting" })).toBe("collecting");
    expect(messageFormat({ msg: "hello" })).toBe("hello");
  });
});
