import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { stageNodeLooseProject } from "./fixture.js";

// 3a-i RED→GREEN GATE (pin-then-pure, ADR 0006c):
//   a LOOSE Node manifest (a package.json with NO lockfile) → dustcastle resolves
//   it ONCE into a generated, committed package-lock.json (`npm install
//   --package-lock-only`, the one-time online resolve), then provisions PURE from
//   that lock → `node --test` runs GREEN offline inside the container, deps from
//   the read-only /nix/store. Strictly better than going impure (ADR 0004): the
//   project gains a real lockfile it lacked, and every build after is offline.
//
// Unlike node-run, this supplies NO known hash — it exercises the live two-pass
// deps-hash discovery against the generated lock (the pm-run posture). Its first
// run on a capable host pays the resolve + discovery build. Gated by DUSTCASTLE_E2E=1.
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

describe("dustcastle run (3a-i: pin-then-pure loose manifest, ADR 0004/0006c)", () => {
  e2e(
    "pins a lockless package.json to a generated lock, then builds pure & tests offline",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-pin-run-"));
      tmps.push(root);
      const projectDir = stageNodeLooseProject(root);

      // The loose fixture has no lockfile to begin with.
      expect(existsSync(join(projectDir, "package-lock.json"))).toBe(false);

      // dustcastle's real pipeline: detect (loose) → pin-then-pure (real
      // `npm install --package-lock-only`) → re-detect → provision PURE → plan.
      const prepared = prepareRun({ cwd: projectDir });

      // The pin step produced the visible, committed artifact.
      expect(prepared.pinned?.lockfile).toBe("package-lock.json");
      expect(existsSync(join(projectDir, "package-lock.json"))).toBe(true);

      // After pinning, it is an ordinary pure npm project (loose signal gone).
      expect(prepared.detection.ecosystem).toBe("node");
      expect(prepared.detection.loose).toBeUndefined();
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

        const which = await handle.exec("command -v node && node --version", { cwd, onLine: log });
        expect(which.exitCode).toBe(0);
        expect(which.stdout).toContain("/nix/store/");

        // Truly offline: the registry is unreachable inside the container.
        const net = await handle.exec("getent hosts registry.npmjs.org || echo OFFLINE_OK", {
          cwd,
          onLine: log,
        });
        expect(net.stdout).toContain("OFFLINE_OK");

        for (const command of prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }

        // THE GATE: tests pass, offline, from the Store — built from the lock we pinned.
        const test = await handle.exec("node --test", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toMatch(/pass 1|# pass 1/);
      } finally {
        await handle.close();
      }
    },
  );
});
