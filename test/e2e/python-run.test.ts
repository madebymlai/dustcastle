import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { stagePythonProject } from "./fixture.js";

// laimk-hse.2 RED→GREEN GATE (the Python pip-FOD ecosystem path):
//   a hash-pinned, wheels-only requirements.txt project → dustcastle provisions it
//   → `python -m pytest` runs GREEN inside a sandcastle podman container, with the
//   python Toolchain (with pip + pytest) AND the assembled site-packages coming
//   entirely from the read-only bind-mounted /nix/store, and the container fully
//   OFFLINE.
//
// This is the Python analogue of the slice-2 Node gate. It proves the pip-FOD
// Importer (src/nix/python.ts) realizes a real site-packages offline: a network-ON
// `pip download --only-binary=:all: --require-hashes` wheelhouse FOD (hash-pinned)
// + an offline `pip install --no-index --find-links` assembly. Wheels run no
// install-time code, so assembly is pure by construction — and the container's
// egress is closed ("none") for this pure project, so nothing could phone home.
//
// It supplies NO known deps hash, so dustcastle discovers the pip-FOD aggregate
// hash via the placeholder probe build (ADR 0004) — self-contained on any host
// with a working nix-portable + network. Gated by DUSTCASTLE_E2E=1; it self-skips
// otherwise. Do NOT run real nix builds in the implementing workflow.
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

describe("dustcastle run (laimk-hse.2: Python pip-FOD pure path, ADR 0002/0003/0004/0005/0008)", () => {
  e2e(
    "runs `python -m pytest` green inside a sandcastle container, offline, deps from the RO Store",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-python-run-"));
      tmps.push(root);
      const projectDir = stagePythonProject(root);

      // dustcastle's real pipeline: detect → resolve impurity → realize the Store
      // → plan the Sandbox. The fixture is wheels-only hash-pinned, so it's pure.
      const prepared = prepareRun({ cwd: projectDir });
      expect(prepared.detection.ecosystem).toBe("python");
      expect(prepared.detection.packageManager).toBe("pip");
      expect(prepared.detection.importer).toBe("pip-FOD");
      expect(prepared.impurity.kind).toBe("pure");
      expect(prepared.plan.podmanOptions.network).toBe("none");
      // The discovered aggregate hash lands in pythonDepsHash (ADR 0006 amendment).
      expect(prepared.provisioned.pythonDepsHash).toBeTruthy();

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

        // The python Toolchain resolves from the read-only Store mount.
        const which = await handle.exec("command -v python && python --version", { cwd, onLine: log });
        expect(which.exitCode).toBe(0);
        expect(which.stdout).toContain("/nix/store/");

        // Truly offline: a DNS lookup of PyPI must fail inside the container.
        const net = await handle.exec("getent hosts pypi.org || echo OFFLINE_OK", { cwd, onLine: log });
        expect(net.stdout).toContain("OFFLINE_OK");

        // dustcastle's per-project staging: site-packages copied from the RO Store.
        for (const command of prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }

        // THE GATE: the project's tests pass, offline, from the shared Store.
        // PYTHONPATH=site (set by the plan's env) lets pytest import the staged deps.
        const test = await handle.exec("python -m pytest -q", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toMatch(/2 passed|passed/);
      } finally {
        await handle.close();
      }
    },
  );
});
