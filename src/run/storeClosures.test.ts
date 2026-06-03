import { describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import type { Provisioned } from "../store/index.js";
import type { EcosystemPlan } from "../sandbox/plan.js";
import { gcProjectKey, storeClosures } from "./storeClosures.js";

function provisioned(toolchainStorePath: string): Provisioned {
  return {
    mode: "bwrap",
    physStoreRoot: "/home/agent/.nix-portable/nix/store",
    toolchainStorePath,
  };
}

function ecosystem(detection: Detection, toolchainStorePath: string): EcosystemPlan {
  return { detection, provisioned: provisioned(toolchainStorePath) };
}

describe("storeClosures", () => {
  it("maps every Ecosystem to a Store closure keyed by gcProjectKey", () => {
    const node = ecosystem(
      { ecosystem: "node", packageManager: "npm" },
      "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1",
    );
    const python = ecosystem(
      { ecosystem: "python", packageManager: "pip", loose: true },
      "/nix/store/8g9v0z1zlv5n1xm02r6xw6a3vbp2xq7c-python3-3.12.7",
    );

    const closures = storeClosures([node, python]);

    expect([...closures.keys()]).toEqual([gcProjectKey(node), gcProjectKey(python)]);
    expect(closures.get(gcProjectKey(node))).toBe(node.provisioned);
    expect(closures.get(gcProjectKey(python))).toBe(python.provisioned);
  });

  it("dedups Ecosystems that resolve to the same Store closure key", () => {
    const first = ecosystem(
      { ecosystem: "node", packageManager: "npm" },
      "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1",
    );
    const sameToolchain = ecosystem(
      { ecosystem: "node", packageManager: "npm", loose: true },
      "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-nodejs-20.18.1",
    );

    const closures = storeClosures([first, sameToolchain]);

    expect(closures.size).toBe(1);
    expect([...closures.keys()]).toEqual([gcProjectKey(first)]);
    expect(closures.get(gcProjectKey(first))).toBe(sameToolchain.provisioned);
  });
});
