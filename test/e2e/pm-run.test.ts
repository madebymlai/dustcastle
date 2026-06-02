import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EGRESS_NETWORK } from "../../src/sandbox/confine.js";
import { egressHosts } from "../../src/sandbox/egress.js";
import { prepareRun } from "../../src/run/index.js";
import { PNPM_SAMPLE, YARN_SAMPLE, runInSandbox, stageFixtureProject } from "./fixture.js";

// SLICE 2b GATE — the pnpm + yarn ecosystem paths under ADR 0012:
//   a pnpm/yarn project → dustcastle provisions the Node Toolchain (only) → `node
//   --test` runs GREEN inside a podman container, with node_modules installed
//   IN-SANDBOX by a real `pnpm install --frozen-lockfile` / `yarn install
//   --frozen-lockfile` routed through the standing egress proxy (each manager's
//   registry is on the allowlist), NOT mounted offline from a deps FOD.
//
// (Pre-ADR-0012 this was a pure, offline build with `network: none`; that model is
// gone — see ADR 0012 and dustcastle-61j.) Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const CASES = [
  { manager: "pnpm", fixture: PNPM_SAMPLE, registry: "registry.npmjs.org", install: "pnpm install" },
  { manager: "yarn", fixture: YARN_SAMPLE, registry: "registry.yarnpkg.com", install: "yarn install" },
] as const;

describe("dustcastle run (slice 2b: pnpm/yarn in-Sandbox install, ADR 0002/0005/0008/0012)", () => {
  for (const { manager, fixture, registry, install } of CASES) {
    e2e(
      `installs node_modules in-Sandbox via the egress proxy for a ${manager} project, then runs \`node --test\` green`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), `dustcastle-${manager}-run-`));
        tmps.push(root);
        const projectDir = stageFixtureProject(fixture, root);

        const prepared = prepareRun({ cwd: projectDir });
        expect(prepared.detection.ecosystem).toBe("node");
        expect(prepared.detection.packageManager).toBe(manager);
        expect(prepared.provisioned.depsStorePath).toBe(""); // toolchain-only Store (ADR 0012)
        expect(prepared.plan.egress.kind).toBe("allowlist");
        expect(prepared.plan.podmanOptions.network).toBe(EGRESS_NETWORK);
        expect(egressHosts(prepared.plan.egress)).toContain(registry);
        expect(prepared.plan.setupCommands.join("\n")).toContain(install);

        await runInSandbox({
          prepared,
          projectDir,
          container: `dustcastle-${manager}-run-e2e`,
          test: { command: "node --test", expect: /pass 1|# pass 1/ },
        });
      },
    );
  }
});
