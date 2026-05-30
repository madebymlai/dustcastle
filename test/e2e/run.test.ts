import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { KNOWN_VENDOR_HASH, stageSampleProject } from "./fixture.js";

// SLICE 1 RED→GREEN GATE (the kickoff spec):
//   a Go project → dustcastle provisions it → `go test ./...` runs GREEN inside a
//   sandcastle podman container, with the toolchain + deps coming entirely from
//   the read-only bind-mounted /nix/store, and the container fully OFFLINE.
//
// This drives the deterministic provisioning seam (no LLM agent): prepareRun()
// does dustcastle's real work, then we stand up sandcastle's actual podman
// provider from the planned options and run the project's tests. The mount/env
// seam is identical under sandcastle.run() (same podman() options), so this
// de-risks exactly what the kickoff asks for. Gated behind DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

// The runtime shape of sandcastle's bind-mount provider (create() drives a
// container directly — sufficient to assert the seam without an agent).
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

describe("dustcastle run (slice 1: Go path, ADR 0002/0003/0004/0005/0008)", () => {
  e2e(
    "runs `go test` green inside a sandcastle container, offline, toolchain from the RO Store",
    async () => {
      // A Go project on disk (named "sample" so the build hits the warm Store).
      const root = mkdtempSync(join(tmpdir(), "dustcastle-run-"));
      tmps.push(root);
      const projectDir = stageSampleProject(root);

      // dustcastle's real pipeline: detect → realize the Store → plan the Sandbox.
      const prepared = prepareRun({
        cwd: projectDir,
        vendorHash: KNOWN_VENDOR_HASH,
      });
      expect(prepared.detection.ecosystem).toBe("go");
      expect(prepared.plan.podmanOptions.network).toBe("none");

      // Stand up sandcastle's actual podman provider from the planned options —
      // this carries the /nix/store RO mount + the Go env (ADR 0002 seam).
      const provider = podman(prepared.plan.podmanOptions) as unknown as CreatableProvider;
      const handle = await provider.create({
        worktreePath: projectDir,
        hostRepoPath: projectDir,
        mounts: [{ hostPath: projectDir, sandboxPath: "/home/agent/workspace", readonly: false }],
        // The low-level create() path applies create-level env (sandcastle.run()
        // applies the provider-level env); deliver dustcastle's planned Go env here.
        env: prepared.plan.podmanOptions.env ?? {},
      });

      try {
        const cwd = "/home/agent/workspace";
        const log = (line: string) => process.stderr.write(`   | ${line}\n`);

        // The toolchain resolves from the read-only Store mount.
        const which = await handle.exec("command -v go && go version", { cwd, onLine: log });
        expect(which.exitCode).toBe(0);
        expect(which.stdout).toContain("/nix/store/");

        // Truly offline: a DNS lookup must fail inside the container.
        const net = await handle.exec("getent hosts proxy.golang.org || echo OFFLINE_OK", {
          cwd,
          onLine: log,
        });
        expect(net.stdout).toContain("OFFLINE_OK");

        // dustcastle's per-project staging: deps copied from the RO Store mount.
        for (const command of prepared.plan.setupCommands) {
          const setup = await handle.exec(command, { cwd, onLine: log });
          expect(setup.exitCode).toBe(0);
        }

        // THE GATE: the project's tests pass, offline, from the shared Store.
        const test = await handle.exec("go test -v ./...", { cwd, onLine: log });
        expect(test.exitCode).toBe(0);
        expect(test.stdout).toContain("PASS");
      } finally {
        await handle.close();
      }
    },
  );
});
