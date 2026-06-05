import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EGRESS_NETWORK } from "../../src/sandbox/confine.js";
import { egressHosts } from "../../src/sandbox/confine.js";
import { prepareRun } from "../../src/run/index.js";
import { runInSandbox, stageSampleProject } from "./fixture.js";

// SLICE 1 GATE — the Go ecosystem path under ADR 0012 (impure cached deps):
//   a Go project → dustcastle provisions the Go Toolchain (only) into the Store →
//   `go test ./...` runs GREEN inside a podman container, with the modules fetched
//   IN-SANDBOX by a real `go mod download` routed through the standing egress proxy
//   (the Go module proxy is on the allowlist), NOT mounted offline from a deps FOD.
//
// (Pre-ADR-0012 this was a pure, offline build with deps in the Store and
// `network: none`; that model is gone — see ADR 0012 and dustcastle-61j.) Gated by
// DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("dustcastle run (slice 1: Go in-Sandbox install, ADR 0002/0005/0008/0012)", () => {
  e2e(
    "fetches Go modules in-Sandbox via the egress proxy, then runs `go test` green",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-run-"));
      tmps.push(root);
      const projectDir = stageSampleProject(root);

      // dustcastle's real pipeline: detect → provision the Toolchain → plan the Sandbox.
      const prepared = await prepareRun({ cwd: projectDir });
      expect(prepared.ecosystems[0].detection.ecosystem).toBe("go");
      expect(prepared.plan.egress.kind).toBe("allowlist");
      expect(prepared.plan.podmanOptions.network).toBe(EGRESS_NETWORK);
      expect(egressHosts(prepared.plan.egress)).toContain("proxy.golang.org");

      expect(prepared.plan.setupCommands.join("\n")).toContain("go mod download");

      await runInSandbox({
        prepared,
        projectDir,
        container: "dustcastle-go-run-e2e",
        test: { command: "go test -v ./...", expect: /PASS/ },
      });
    },
  );
});
