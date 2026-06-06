import { afterEach, describe, expect, it, vi } from "vitest";
import type { NixRunner } from "../store/nix.js";
import type { Pool } from "../store/pool.js";
import type { ProvisionOptions, ProvisionStorePoolOptions } from "./index.js";

interface RemovedStoreMechanismOptions {
  readonly gcRoots?: { readonly gcrootsDir?: string; readonly run?: NixRunner };
  readonly autoGc?: {
    readonly run?: NixRunner;
    readonly recencyDir?: string;
    readonly recencyRootsDir?: string;
    readonly spawn?: () => void;
  };
}

type LegacyProvisionOptions = ProvisionOptions & RemovedStoreMechanismOptions;

const mocks = vi.hoisted(() => {
  const nixRunner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
  const cachePool = { pin: vi.fn(), release: vi.fn() };
  return {
    nixRunner,
    cachePool,
    podman: vi.fn((opts: unknown) => ({ opts })),
    detect: vi.fn(() => [{ packageManager: "npm" }]),
    planSandbox: vi.fn((_spec: unknown) => ({
      podmanOptions: {},
      setupCommands: [],
      hostWorktreeReady: [],
      populate: [],
    })),
    ensureImage: vi.fn(async () => {}),
    provisionStore: vi.fn(async () => ({
      mode: "nix-portable",
      physStoreRoot: "/tmp/nix/store",
      toolchainStorePath: "/nix/store/abc-toolchain",
    })),
    storeHashOf: vi.fn(() => "abc"),
    nixPortableRunner: vi.fn(() => nixRunner),
    depsCacheDecision: vi.fn(() => undefined),
    defaultDepsCacheDir: vi.fn(() => "/tmp/dustcastle-deps-cache"),
    depsCachePool: vi.fn(() => cachePool),
    populateCommand: vi.fn(() => "true"),
    spawnAutoGc: vi.fn(),
    agentAuthMounts: vi.fn(() => []),
    loadCredentialValues: vi.fn(() => ({})),
    runStreamingAsync: vi.fn(async () => {}),
  };
});

vi.mock("@ai-hero/sandcastle", () => ({ run: vi.fn(), createSandbox: vi.fn() }));
vi.mock("@ai-hero/sandcastle/sandboxes/podman", () => ({ podman: mocks.podman }));
vi.mock("../detect/index.js", () => ({ detect: mocks.detect }));
vi.mock("../detect/workspace.js", () => ({ detectWorkspace: vi.fn() }));
vi.mock("../sandbox/plan.js", () => ({ planSandbox: mocks.planSandbox }));
vi.mock("../sandbox/image.js", () => ({ AGENT_SPEC: { image: "agent" }, ensureImage: mocks.ensureImage }));
vi.mock("../store/index.js", () => ({ provisionStore: mocks.provisionStore, storeHashOf: mocks.storeHashOf }));
vi.mock("../store/nix.js", () => ({ nixPortableRunner: mocks.nixPortableRunner }));
vi.mock("../store/depscache/index.js", () => ({
  depsCacheDecision: mocks.depsCacheDecision,
  defaultDepsCacheDir: mocks.defaultDepsCacheDir,
  depsCachePool: mocks.depsCachePool,
  populateCommand: mocks.populateCommand,
}));
vi.mock("../cli/autogc.js", () => ({ spawnAutoGc: mocks.spawnAutoGc }));
vi.mock("../config/global.js", () => ({
  DUSTCASTLE_HOME: "/home/dustcastle",
  agentAuthMounts: mocks.agentAuthMounts,
  loadCredentialValues: mocks.loadCredentialValues,
}));
vi.mock("../process/streaming.js", () => ({ runStreamingAsync: mocks.runStreamingAsync }));

import { withProvisionedSandbox } from "./index.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("withProvisionedSandbox Store pool seam", () => {
  it("provisions without standing up scoped egress or threading confinement into the plan", async () => {
    const pool: Pool = {
      measure: vi.fn(() => 0),
      entries: vi.fn(() => []),
      pin: vi.fn(),
      warm: vi.fn(),
      release: vi.fn(),
      evict: vi.fn(() => ({ entriesEvicted: 0, bytesFreed: 0 })),
    };

    await expect(
      withProvisionedSandbox({ cwd: "/repo", makeStorePool: () => pool }, async () => "ok"),
    ).resolves.toBe("ok");

    expect(mocks.planSandbox).toHaveBeenCalledWith({
      ecosystems: expect.any(Array),
      cacheDir: "/tmp/dustcastle-deps-cache",
      credentials: {},
    });
    const [planSpec] = mocks.planSandbox.mock.calls[0] ?? [];
    const [podmanOptions] = mocks.podman.mock.calls[0] ?? [];
    expect(planSpec).not.toHaveProperty("confinement");
    expect(podmanOptions).not.toHaveProperty("network");
    expect(mocks.ensureImage).toHaveBeenCalledTimes(1);
  });

  it("ignores the deleted Store-runner panel and routes Store mechanics only through makeStorePool", async () => {
    const legacyRunner = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const legacyAutoGcSpawn = vi.fn();
    const pool: Pool = {
      measure: vi.fn(() => 0),
      entries: vi.fn(() => []),
      pin: vi.fn(),
      warm: vi.fn(),
      release: vi.fn(),
      evict: vi.fn(() => ({ entriesEvicted: 0, bytesFreed: 0 })),
    };
    const poolOpts: ProvisionStorePoolOptions[] = [];
    const opts: LegacyProvisionOptions = {
      cwd: "/repo",
      makeStorePool: (storePoolOpts) => {
        poolOpts.push(storePoolOpts);
        return pool;
      },
      // Legacy runtime options must be dead: callers that need alternate Store
      // mechanics replace the whole pool via makeStorePool instead.
      gcRoots: { run: legacyRunner, gcrootsDir: "/legacy/gcroots" },
      autoGc: {
        run: legacyRunner,
        recencyDir: "/legacy/recency",
        recencyRootsDir: "/legacy/recency-roots",
        spawn: legacyAutoGcSpawn,
      },
    };

    const run = withProvisionedSandbox(opts, async () => "ok");

    await expect(run).resolves.toBe("ok");

    expect(poolOpts).toHaveLength(1);
    expect(poolOpts[0]).toEqual({
      closures: expect.any(Map),
      logger: expect.any(Object),
    });
    expect(mocks.nixPortableRunner).not.toHaveBeenCalled();
    expect(legacyRunner).not.toHaveBeenCalled();
    expect(legacyAutoGcSpawn).not.toHaveBeenCalled();
    expect(mocks.spawnAutoGc).toHaveBeenCalledTimes(1);
  });
});
