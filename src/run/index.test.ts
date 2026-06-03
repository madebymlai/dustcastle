import { describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_HOOK_TIMEOUT_MS,
  gcProjectKey,
  installHookTimeoutMs,
  withSetupHooks,
  type GcProjectKeyInput,
} from "./index.js";
import type { SandboxPlan } from "../sandbox/plan.js";

function planWith(setupCommands: string[]): SandboxPlan {
  return { setupCommands, hostWorktreeReady: [] } as unknown as SandboxPlan;
}

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

describe("withSetupHooks install timeout", () => {
  // Regression (the pip-install-hook 60s timeout): sandcastle caps every
  // onSandboxReady hook at HOOK_TIMEOUT_MS=60s by default, so an install hook with
  // no explicit timeoutMs is killed mid-resolve. dustcastle MUST stamp a generous
  // timeoutMs on its OWN install hooks — never inherit the 60s default.
  it("gives every dustcastle install hook a timeout well above sandcastle's 60s default", () => {
    const hooks = withSetupHooks(undefined, planWith(["pip install -r requirements.txt --target site"]));

    const onReady = hooks.sandbox?.onSandboxReady ?? [];
    expect(onReady).toHaveLength(1);
    for (const hook of onReady) {
      expect(hook.timeoutMs).toBe(DEFAULT_INSTALL_HOOK_TIMEOUT_MS);
      expect(hook.timeoutMs).toBeGreaterThan(60_000);
    }
  });

  it("uses the explicit install timeout when one is passed", () => {
    const hooks = withSetupHooks(undefined, planWith(["npm install"]), 600_000);

    expect(hooks.sandbox?.onSandboxReady?.[0]?.timeoutMs).toBe(600_000);
  });

  it("does NOT force the install timeout onto caller hooks (they keep sandcastle's default)", () => {
    const hooks = withSetupHooks(
      { sandbox: { onSandboxReady: [{ command: "echo hi" }] } },
      planWith(["pip install -r requirements.txt --target site"]),
    );

    const onReady = hooks.sandbox?.onSandboxReady ?? [];
    // dustcastle's install first (with timeout), the caller's untouched after it.
    expect(onReady[0]?.timeoutMs).toBe(DEFAULT_INSTALL_HOOK_TIMEOUT_MS);
    expect(onReady[1]).toEqual({ command: "echo hi" });
  });
});

describe("installHookTimeoutMs", () => {
  it("defaults when the env knob is unset or empty", () => {
    expect(installHookTimeoutMs({})).toBe(DEFAULT_INSTALL_HOOK_TIMEOUT_MS);
    expect(installHookTimeoutMs({ DUSTCASTLE_INSTALL_TIMEOUT_SECONDS: "" })).toBe(
      DEFAULT_INSTALL_HOOK_TIMEOUT_MS,
    );
  });

  it("reads DUSTCASTLE_INSTALL_TIMEOUT_SECONDS as a global seconds override", () => {
    expect(installHookTimeoutMs({ DUSTCASTLE_INSTALL_TIMEOUT_SECONDS: "1800" })).toBe(1_800_000);
  });

  it("rejects a non-positive or non-numeric override instead of silently ignoring it", () => {
    expect(() => installHookTimeoutMs({ DUSTCASTLE_INSTALL_TIMEOUT_SECONDS: "0" })).toThrow(
      /positive integer/,
    );
    expect(() => installHookTimeoutMs({ DUSTCASTLE_INSTALL_TIMEOUT_SECONDS: "soon" })).toThrow(
      /DUSTCASTLE_INSTALL_TIMEOUT_SECONDS/,
    );
  });
});
