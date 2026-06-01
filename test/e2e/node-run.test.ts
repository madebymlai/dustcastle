import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { KNOWN_NPM_DEPS_HASH, stageNodeProject } from "./fixture.js";

// SLICE 2 RED→GREEN GATE (the Node ecosystem path):
//   a Node project → dustcastle provisions it → `npm test` (node --test) runs
//   GREEN inside a sandcastle podman container, with the nodejs toolchain + the
//   node_modules coming entirely from the read-only bind-mounted /nix/store, and
//   the container fully OFFLINE.
//
// This is the Node analogue of the slice-1 Go gate, and it settles the slice-2
// open question (kickoff point 5): even though rootless nix-portable does NOT
// enforce a no-network build sandbox, safety holds because (a) provisioning runs
// `npm ci --ignore-scripts` — no untrusted lifecycle code runs during the build —
// and (b) the container's egress is closed ("none") for this pure project, so a
// postinstall could not phone home even if one existed. The container egress is
// the real gate; the build sandbox's weakness is irrelevant. Gated by DUSTCASTLE_E2E=1.
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

describe("dustcastle run (slice 2: Node pure path, ADR 0002/0003/0004/0005/0008)", () => {
  e2e(
    "runs `npm test` green inside a sandcastle container, offline, deps from the RO Store",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-node-run-"));
      tmps.push(root);
      const projectDir = stageNodeProject(root);

      // dustcastle's real pipeline: detect → resolve impurity → realize the Store
      // → plan the Sandbox. The fixture has no install scripts, so it's pure.
      const prepared = prepareRun({
        cwd: projectDir,
        depsHash: KNOWN_NPM_DEPS_HASH,
      });
      expect(prepared.detection.ecosystem).toBe("node");
      expect(prepared.impurity.kind).toBe("pure");
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

        // The toolchain resolves from the read-only Store mount.
        const which = await handle.exec("command -v node && node --version", { cwd, onLine: log });
        expect(which.exitCode).toBe(0);
        expect(which.stdout).toContain("/nix/store/");

        // Truly offline: a DNS lookup of the registry must fail inside the container.
        const net = await handle.exec("getent hosts registry.npmjs.org || echo OFFLINE_OK", {
          cwd,
          onLine: log,
        });
        expect(net.stdout).toContain("OFFLINE_OK");

        // dustcastle's per-project staging: node_modules copied from the RO Store.
        for (const command of prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }

        // THE GATE: the project's tests pass, offline, from the shared Store.
        const test = await handle.exec("node --test", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toMatch(/pass 1|# pass 1/);
      } finally {
        await handle.close();
      }
    },
  );
});
