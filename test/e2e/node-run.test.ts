import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRun } from "../../src/run/index.js";
import { runInSandbox, stageNodeProject } from "./fixture.js";

// SLICE 2 GATE — the Node ecosystem path under ADR 0012 (impure cached deps):
//   a Node project → dustcastle provisions its Toolchain (only) into the Store →
//   `node --test` runs GREEN inside a podman container, with node_modules installed
//   IN-SANDBOX by a real `npm install`, NOT mounted offline from a deps FOD. This is
//   the Node case of the shared ADR 0012/0020 run harness.
//
// (Pre-ADR-0012 this was a pure, offline build with deps in the Store and
// `network: none`; that model is gone — see ADR 0012 and dustcastle-61j.) Gated by
// DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("dustcastle run (slice 2: Node in-Sandbox install, ADR 0002/0008/0012/0020)", () => {
  e2e(
    "installs node_modules in-Sandbox over normal networking, then runs `npm test` green",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dustcastle-node-run-"));
      tmps.push(root);
      const projectDir = stageNodeProject(root);

      // dustcastle's real pipeline: detect → provision the Toolchain → plan the
      // Sandbox with normal networking. There is no purity decision any more.
      const prepared = await prepareRun({ cwd: projectDir });
      expect(prepared.ecosystems[0].detection.ecosystem).toBe("node");
      // Toolchain-only Store (ADR 0012): no deps FOD realized.
      expect(prepared.plan).not.toHaveProperty("egress");
      expect(prepared.plan.podmanOptions.network).toBeUndefined();
      // The deps install IN-SANDBOX via `npm install`, not a Store copy.
      expect(prepared.plan.setupCommands.join("\n")).toContain("npm install");

      await runInSandbox({
        prepared,
        projectDir,
        container: "dustcastle-node-run-e2e",
        test: { command: "node --test", expect: /pass 1|# pass 1/ },
      });
    },
  );
});
