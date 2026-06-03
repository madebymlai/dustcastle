import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EGRESS_NETWORK } from "../../src/sandbox/confine.js";
import { egressHosts } from "../../src/sandbox/egress.js";
import { prepareRun } from "../../src/run/index.js";
import {
  runInSandbox,
  stagePythonPoetryProject,
  stagePythonProject,
  stagePythonUvProject,
} from "./fixture.js";

// laimk-hse.2 GATE — the Python ecosystem path under ADR 0012 (impure cached deps):
//   a Python project → dustcastle provisions the python Toolchain (interpreter + pip
//   + pytest, only) into the Store → `python -m pytest` runs GREEN inside a podman
//   container, with site-packages installed IN-SANDBOX by a real `pip install
//   --require-hashes ... --target site` (uv/poetry prepend their `export` step)
//   routed through the standing egress proxy (pypi.org is on the allowlist), NOT
//   mounted offline from a pip-FOD.
//
// uv and poetry route the SAME pip install behind an in-Sandbox `export` front-end
// (`uv export` / `poetry export` materialises the hash-pinned requirements.txt). All
// three are exercised here.
//
// (Pre-ADR-0012 this was a pure, offline pip-FOD build with `network: none`; that
// model is gone — see ADR 0012 and dustcastle-61j.) Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const CASES = [
  { manager: "pip", stage: stagePythonProject, install: "pip install", prefix: "dustcastle-python-run-" },
  { manager: "uv", stage: stagePythonUvProject, install: "uv export", prefix: "dustcastle-python-uv-run-" },
  { manager: "poetry", stage: stagePythonPoetryProject, install: "poetry export", prefix: "dustcastle-python-poetry-run-" },
] as const;

describe("dustcastle run (laimk-hse.2: Python in-Sandbox install, ADR 0002/0005/0008/0012)", () => {
  for (const { manager, stage, install, prefix } of CASES) {
    e2e(
      `detects python/${manager} and installs site-packages in-Sandbox via the egress proxy, then runs pytest green`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), prefix));
        tmps.push(root);
        const projectDir = stage(root);

        const prepared = await prepareRun({ cwd: projectDir });
        expect(prepared.ecosystems[0].detection.ecosystem).toBe("python");
        expect(prepared.ecosystems[0].detection.packageManager).toBe(manager);
        expect(prepared.plan.egress.kind).toBe("allowlist");
        expect(prepared.plan.podmanOptions.network).toBe(EGRESS_NETWORK);
        expect(egressHosts(prepared.plan.egress)).toContain("pypi.org");
        expect(egressHosts(prepared.plan.egress)).toContain("files.pythonhosted.org"); // wheel CDN

        // The deps install IN-SANDBOX: pip directly, uv/poetry behind their export front-end.
        expect(prepared.plan.setupCommands.join("\n")).toContain(install);
        expect(prepared.plan.setupCommands.join("\n")).toContain("pip install");

        await runInSandbox({
          prepared,
          projectDir,
          container: `${prefix}e2e`,
          // PYTHONPATH=site (set by the plan env) lets pytest import the staged deps.
          test: { command: "python -m pytest -q", expect: /2 passed|passed/ },
        });
      },
    );
  }
});
