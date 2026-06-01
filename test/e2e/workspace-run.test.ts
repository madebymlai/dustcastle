import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../src/run/index.js";
import { KNOWN_NPM_DEPS_HASH, stageWorkspaceProject } from "./fixture.js";

// 3a-ii RED→GREEN GATE (per-workspace monorepo detection, ADR 0006d):
//   a workspace root (package.json#workspaces) → dustcastle enumerates its members
//   and provisions EACH into the shared Store, then `node --test` runs GREEN
//   offline in a container per member, deps from the read-only /nix/store.
//
// Both members reuse the pure node-sample, so they share the warm deps hash. Gated
// by DUSTCASTLE_E2E=1.
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

describe("dustcastle (3a-ii: per-workspace monorepo provisioning, ADR 0006d)", () => {
  e2e("enumerates both workspace members and provisions + tests each offline", async () => {
    const root = mkdtempSync(join(tmpdir(), "dustcastle-ws-run-"));
    tmps.push(root);
    const { root: wsRoot, members } = stageWorkspaceProject(root);

    // The fan-out: detect the workspace, provision EACH member into the Store.
    const ws = prepareWorkspace({ cwd: wsRoot, depsHash: KNOWN_NPM_DEPS_HASH });

    expect(ws.isWorkspace).toBe(true);
    expect(ws.members.map((m) => m.dir).sort()).toEqual([...members].sort());

    for (const member of ws.members) {
      expect(member.prepared.detection.ecosystem).toBe("node");
      expect(member.prepared.provisioned.toolchainStorePath).toContain("/nix/store/");

      const provider = podman(member.prepared.plan.podmanOptions) as unknown as CreatableProvider;
      const handle = await provider.create({
        worktreePath: member.dir,
        hostRepoPath: member.dir,
        mounts: [{ hostPath: member.dir, sandboxPath: "/home/agent/workspace", readonly: false }],
        env: member.prepared.plan.podmanOptions.env ?? {},
      });

      try {
        const cwd = "/home/agent/workspace";
        const log = (line: string) => process.stderr.write(`   | [${member.dir}] ${line}\n`);
        for (const command of member.prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }
        const test = await handle.exec("node --test", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toMatch(/pass 1|# pass 1/);
      } finally {
        await handle.close();
      }
    }
  });
});
