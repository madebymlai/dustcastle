import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { stagePythonLooseProject } from "./fixture.js";

// laimk-hse.5 RED→GREEN GATE (Python pin-then-pure, ADR 0006c):
//   a LOOSE Python manifest (an abstract pyproject.toml + an unpinned
//   requirements.in, NO lock-grade requirements.txt) → dustcastle resolves it ONCE
//   into a generated, committed, hash-pinned requirements.txt (`uv pip compile
//   --generate-hashes`, the one-time online resolve), then provisions PURE through
//   the pip-FOD from that lock → `python -m pytest` runs GREEN offline inside the
//   container, deps from the read-only /nix/store. Strictly better than going
//   impure (ADR 0004): the repo gains a real, hash-pinned lock it lacked, and every
//   build after is offline.
//
// The Python analogue of the Node pin-run gate (test/e2e/pin-run.test.ts). Supplies
// NO known hash — it exercises the live pip-FOD aggregate-hash discovery against the
// freshly generated lock. Requires `uv` on the host PATH for the resolve. Gated by
// DUSTCASTLE_E2E=1; self-skips otherwise. Do NOT run real nix builds in the
// implementing workflow.
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

describe("dustcastle run (laimk-hse.5: loose Python pin-then-pure, ADR 0004/0006c)", () => {
  e2e(
    "pins a loose requirements.in to a hash-pinned requirements.txt, then builds pure & tests offline",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-python-pin-run-"));
      tmps.push(root);
      const projectDir = stagePythonLooseProject(root);

      // The loose fixture has no lock-grade requirements.txt to begin with.
      expect(existsSync(join(projectDir, "requirements.txt"))).toBe(false);

      // dustcastle's real pipeline: detect (loose) → pin-then-pure (real `uv pip
      // compile --generate-hashes`) → re-detect → provision PURE via the pip-FOD.
      const prepared = prepareRun({ cwd: projectDir });

      // The pin step produced the VISIBLE, committed artifact.
      expect(prepared.pinned?.lockfile).toBe("requirements.txt");
      expect(existsSync(join(projectDir, "requirements.txt"))).toBe(true);
      // The resolve output is hash-pinned (the never-silent invariant, ADR 0004).
      const lock = readFileSync(join(projectDir, "requirements.txt"), "utf8");
      expect(lock).toMatch(/--hash=sha256:/);
      expect(lock).toMatch(/idna==/);

      // After pinning, it is an ordinary pure Python project (loose signal gone).
      expect(prepared.detection.ecosystem).toBe("python");
      expect(prepared.detection.packageManager).toBe("pip");
      expect(prepared.detection.loose).toBeUndefined();
      expect(prepared.impurity.kind).toBe("pure");
      expect(prepared.plan.podmanOptions.network).toBe("none");
      expect(prepared.provisioned.depsHash).toBeTruthy();

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

        const which = await handle.exec("command -v python && python --version", { cwd, onLine: log });
        expect(which.exitCode).toBe(0);
        expect(which.stdout).toContain("/nix/store/");

        // Truly offline: a DNS lookup of PyPI must fail inside the container.
        const net = await handle.exec("getent hosts pypi.org || echo OFFLINE_OK", { cwd, onLine: log });
        expect(net.stdout).toContain("OFFLINE_OK");

        for (const command of prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }

        // THE GATE: tests pass, offline, from the Store — built from the lock we pinned.
        const test = await handle.exec("python -m pytest -q", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toMatch(/2 passed|passed/);
      } finally {
        await handle.close();
      }
    },
  );
});
