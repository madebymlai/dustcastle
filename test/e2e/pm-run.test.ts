import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { PNPM_SAMPLE, YARN_SAMPLE, stageFixtureProject } from "./fixture.js";

// SLICE 2b RED→GREEN GATE (the pnpm + yarn ecosystem paths):
//   a pnpm/yarn project → dustcastle provisions it → `node --test` runs GREEN
//   inside a sandcastle podman container, with the nodejs toolchain + the
//   node_modules coming entirely from the read-only bind-mounted /nix/store, and
//   the container fully OFFLINE.
//
// This is the pnpm/yarn analogue of the slice-2 npm gate. It proves the new
// importers (src/nix/pnpm.ts, src/nix/yarn.ts) realize a real node_modules
// offline: pnpm via fetchPnpmDeps + an `--ignore-scripts` `pnpm install`, yarn
// via fetchYarnDeps + a `yarnConfigHook` install. As with npm, safety holds
// because (a) provisioning never runs untrusted lifecycle scripts, and (b) the
// container's egress is closed ("none") for these pure projects.
//
// Unlike the npm gate this supplies NO known deps hash, so dustcastle discovers
// it via the placeholder probe build (ADR 0004) — self-contained on any host with
// a working nix-portable + network. Gated by DUSTCASTLE_E2E=1; it self-skips
// otherwise (and on hosts without a warm pnpm/yarn store it is the only proof).
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

const CASES = [
  { manager: "pnpm", importer: "fetchPnpmDeps", fixture: PNPM_SAMPLE },
  { manager: "yarn", importer: "fetchYarnDeps", fixture: YARN_SAMPLE },
] as const;

describe("dustcastle run (slice 2b: pnpm/yarn pure path, ADR 0002/0003/0004/0005/0008)", () => {
  for (const { manager, importer, fixture } of CASES) {
    e2e(
      `runs \`node --test\` green for a ${manager} project, offline, deps from the RO Store`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), `dustcastle-${manager}-run-`));
        tmps.push(root);
        const projectDir = stageFixtureProject(fixture, root);

        // dustcastle's real pipeline: detect → resolve impurity → realize the Store
        // → plan the Sandbox. The fixture has no install scripts, so it's pure. No
        // known hash supplied → the store discovers it via the placeholder probe.
        const prepared = prepareRun({ cwd: projectDir });
        expect(prepared.detection.ecosystem).toBe("node");
        expect(prepared.detection.packageManager).toBe(manager);
        expect(prepared.detection.importer).toBe(importer);
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
  }
});
