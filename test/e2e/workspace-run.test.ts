import { mkdtempSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareWorkspace } from "../../src/run/index.js";
import { runInSandbox, stageWorkspaceProject } from "./fixture.js";

// 3a-ii GATE — per-workspace monorepo provisioning under ADR 0012 (ADR 0006d):
//   a workspace root (package.json#workspaces) → dustcastle enumerates its members
//   and provisions EACH member's Toolchain into the shared Store, then `node --test`
//   runs GREEN per member, with node_modules installed IN-SANDBOX via the egress
//   proxy (the shared ADR 0012 run harness), NOT mounted offline from a deps FOD.
//
// Both members reuse the node-sample, so they share the npm registry allowlist.
// Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("dustcastle (3a-ii: per-workspace monorepo in-Sandbox install, ADR 0006d/0012)", () => {
  e2e("enumerates both workspace members and installs + tests each in-Sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "dustcastle-ws-run-"));
    tmps.push(root);
    const { root: wsRoot, members } = stageWorkspaceProject(root);

    // The fan-out: detect the workspace, provision EACH member's Toolchain.
    const ws = await prepareWorkspace({ cwd: wsRoot });

    expect(ws.isWorkspace).toBe(true);
    expect(ws.members.map((m) => m.dir).sort()).toEqual([...members].sort());

    for (const member of ws.members) {
      expect(member.prepared.detection.ecosystem).toBe("node");
      expect(member.prepared.provisioned.toolchainStorePath).toContain("/nix/store/");

      await runInSandbox({
        prepared: member.prepared,
        projectDir: member.dir,
        container: `dustcastle-ws-run-${basename(member.dir)}-e2e`,
        test: { command: "node --test", expect: /pass 1|# pass 1/ },
      });
    }
  });
});
