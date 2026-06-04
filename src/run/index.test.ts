import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_HOOK_TIMEOUT_MS,
  gcProjectKey,
  installHookTimeoutMs,
  populateDepsCache,
  withSetupHooks,
  type GcProjectKeyInput,
} from "./index.js";
import { createMemoryLogger } from "../log/fake.js";
import type { SandboxPlan } from "../sandbox/plan.js";
import { completeMarker, installSuccessSentinel, type DepsCachePopulate } from "../store/depscache/index.js";

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

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

describe("populateDepsCache", () => {
  it("streams stderr lines live via the logger before the child closes", async () => {
    const logger = createMemoryLogger();
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-populate-"));
    tmps.push(dir);
    const cacheDir = join(dir, "cache");
    const stageDir = join(dir, "stage");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "dep.txt"), "hello");

    const depsKey = "abc123";
    const populate: DepsCachePopulate[] = [{ depsKey, stageDir }];

    await populateDepsCache(dir, cacheDir, populate, logger);

    // The streamed "caching <dir> deps (key <hash>)" line reaches the logger at info,
    // with the deps key trimmed to 12 chars (the message IS the line — see emitLine).
    expect(
      logger.records.some((r) => r.level === "info" && r.msg?.includes("deps (key abc123)") === true),
    ).toBe(true);
  });

  it("populates only after the in-Sandbox install success sentinel exists", async () => {
    const logger = createMemoryLogger();
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-populate-sentinel-"));
    tmps.push(dir);
    const cacheDir = join(dir, "cache");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep.txt"), "hello");

    const populate: DepsCachePopulate[] = [{ depsKey: "abc123", stageDir: "node_modules" }];
    await populateDepsCache(dir, cacheDir, populate, logger);
    expect(existsSync(join(cacheDir, "abc123", "node_modules"))).toBe(false);

    writeFileSync(join(dir, installSuccessSentinel("node_modules")), "");
    await populateDepsCache(dir, cacheDir, populate, logger);
    expect(existsSync(join(cacheDir, "abc123", "node_modules", "dep.txt"))).toBe(true);
    expect(existsSync(completeMarker(cacheDir, "abc123"))).toBe(true);
  });
});
