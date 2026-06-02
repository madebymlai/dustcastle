import { describe, expect, it } from "vitest";
import { gcProjectKey, type PreparedRun } from "./index.js";

function preparedRun(packageManager: "npm" | "pnpm", toolchainStorePath: string): PreparedRun {
  return {
    detection: { ecosystem: "node", packageManager },
    provisioned: {
      mode: "bwrap",
      physStoreRoot: "/phys/store",
      toolchainStorePath,
    },
  } as unknown as PreparedRun;
}

describe("gcProjectKey", () => {
  it("keys Store recency by package manager and Toolchain store hash", () => {
    const node20 = "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1";
    const alsoNode20 = "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1";
    const node22 = "/nix/store/8g9v0z1zlv5n1xm02r6xw6a3vbp2xq7c-nodejs-22.11.0";

    expect(gcProjectKey(preparedRun("npm", node20))).toBe(
      "npm-33fw5m31lfcnk4ff2f0df7j2bxnh8lgk",
    );
    expect(gcProjectKey(preparedRun("npm", alsoNode20))).toBe(gcProjectKey(preparedRun("npm", node20)));
    expect(gcProjectKey(preparedRun("npm", node22))).not.toBe(gcProjectKey(preparedRun("npm", node20)));
    expect(gcProjectKey(preparedRun("pnpm", node20))).toBe(
      "pnpm-33fw5m31lfcnk4ff2f0df7j2bxnh8lgk",
    );
  });
});
