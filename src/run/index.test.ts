import { describe, expect, it } from "vitest";
import { gcProjectKey, type GcProjectKeyInput } from "./index.js";

function gcKeyInput(packageManager: "npm" | "pnpm", toolchainStorePath: string): GcProjectKeyInput {
  return {
    detection: { packageManager },
    provisioned: { toolchainStorePath },
  };
}

describe("gcProjectKey", () => {
  it("keys Store recency by package manager and Toolchain store hash", () => {
    const node20 = "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1";
    const sameNode20 = "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1";
    const node22 = "/nix/store/8g9v0z1zlv5n1xm02r6xw6a3vbp2xq7c-nodejs-22.11.0";

    const npmNode20Key = gcProjectKey(gcKeyInput("npm", node20));

    expect(npmNode20Key).toBe("npm-33fw5m31lfcnk4ff2f0df7j2bxnh8lgk");
    expect(gcProjectKey(gcKeyInput("npm", sameNode20))).toBe(npmNode20Key);
    expect(gcProjectKey(gcKeyInput("npm", node22))).not.toBe(npmNode20Key);
    expect(gcProjectKey(gcKeyInput("pnpm", node20))).toBe(
      "pnpm-33fw5m31lfcnk4ff2f0df7j2bxnh8lgk",
    );
  });
});
