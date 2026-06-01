import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../../src/nix/rust.js";
import { prepareRun } from "../../src/run/index.js";
import { stageRustGitProject, stageRustProject } from "./fixture.js";

// Rust happy-path (dustcastle-gy5.2): a committed Cargo.lock provisions pure,
// stages deps into CARGO_HOME with the existing cp -RL path, and cargo test runs
// offline in the real sandcastle podman container. Gated behind DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

interface BindMountHandle {
  readonly worktreePath: string;
  exec(
    command: string,
    options?: { cwd?: string; onLine?: (line: string) => void },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}
interface CreatableProvider {
  create(options: {
    worktreePath: string;
    hostRepoPath: string;
    mounts: Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }>;
    env: Record<string, string>;
  }): Promise<BindMountHandle>;
}

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

async function expectRustFixtureOffline(stage: (root: string) => string, tmpPrefix: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), tmpPrefix));
  tmps.push(root);
  const projectDir = stage(root);

  const prepared = prepareRun({ cwd: projectDir });
  expect(prepared.detection).toMatchObject({ ecosystem: "rust", packageManager: "cargo" });
  expect(prepared.plan.podmanOptions.network).toBe("none");

  const provider = podman(prepared.plan.podmanOptions) as unknown as CreatableProvider;
  const handle = await provider.create({
    worktreePath: projectDir,
    hostRepoPath: projectDir,
    mounts: [{ hostPath: projectDir, sandboxPath: "/home/agent/workspace", readonly: false }],
    env: prepared.plan.podmanOptions.env ?? {},
  });

  try {
    const cwd = "/home/agent/workspace";
    const log = (line: string) => process.stderr.write(`   | ${line}\n`);

    const which = await handle.exec("command -v cargo && cargo --version", { cwd, onLine: log });
    expect(which.exitCode).toBe(0);
    expect(which.stdout).toContain("/nix/store/");

    const net = await handle.exec("getent hosts static.crates.io || echo OFFLINE_OK", { cwd, onLine: log });
    expect(net.stdout).toContain("OFFLINE_OK");

    for (const command of prepared.plan.setupCommands) {
      const setup = await handle.exec(command, { cwd, onLine: log });
      expect(setup.exitCode).toBe(0);
    }
    const cargoHome = await handle.exec("test -d \"$CARGO_HOME/vendor\" && printf CARGO_HOME_OK", { cwd });
    expect(cargoHome.stdout).toContain("CARGO_HOME_OK");
    expect(prepared.plan.setupCommands.join("\n")).toContain(CARGO_HOME_BASENAME);

    const test = await handle.exec("cargo test --offline --frozen", { cwd, onLine: log });
    expect(test.exitCode).toBe(0);
    expect(test.stdout).toContain("test result: ok");
  } finally {
    await handle.close();
  }
}

describe("dustcastle run — Rust pure path (dustcastle-gy5.2)", () => {
  e2e("runs cargo test green inside a sandcastle container, fully offline", async () => {
    await expectRustFixtureOffline(stageRustProject, "dustcastle-rust-run-");
  });

  e2e("vendors a Cargo git dependency under the aggregate hash and resolves it offline", async () => {
    await expectRustFixtureOffline(stageRustGitProject, "dustcastle-rust-git-run-");
  });
});
