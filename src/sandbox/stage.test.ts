import { describe, expect, it } from "vitest";
import type { SandboxStaging } from "../ecosystems/index.js";
import { stageCommands } from "./plan.js";

// stageCommands emits the PURE-path Project-Deps staging ONCE (ADR 0002): the
// self-healing clear, the `cp -RL` from the resolved source, and the trailing
// chmod. The per-Ecosystem `if` ladder in setupFor is gone — these assertions pin
// the command shape the Registry's `sandbox` facet now drives.

describe("stageCommands (pure Project-Deps staging, ADR 0002)", () => {
  const STORE = "/nix/store/dddd-app-deps-0.0.0";
  // stageCommands reads only stageDir/storeSubpath; the facet's `env` (the run
  // environment) is exercised by ecosystems.test.ts, so a no-op satisfies the type.
  const noEnv = () => ({});

  it("clears the target self-healingly: chmod writable BEFORE the rm", () => {
    // A `cp -RL` from the read-only Store reproduces its 555 dir mode, so a staging
    // interrupted before the trailing chmod leaves a read-only target that `rm -rf`
    // CANNOT remove (no write bit ⇒ can't unlink contents). The leading chmod (with
    // `2>/dev/null; ` so it's a no-op when nothing is there) makes it self-healing.
    const node: SandboxStaging = { stageDir: "node_modules", storeSubpath: "node_modules", env: noEnv };
    const clear = stageCommands(node, STORE)[0] ?? "";
    expect(clear).toBe("chmod -R u+w node_modules 2>/dev/null; rm -rf node_modules");
    expect(clear.indexOf("chmod")).toBeLessThan(clear.indexOf("rm -rf"));
  });

  it("joins storeSubpath onto depsStorePath for the cp source (node)", () => {
    const node: SandboxStaging = { stageDir: "node_modules", storeSubpath: "node_modules", env: noEnv };
    expect(stageCommands(node, STORE)).toEqual([
      "chmod -R u+w node_modules 2>/dev/null; rm -rf node_modules",
      `cp -RL ${STORE}/node_modules node_modules`,
      "chmod -R u+w node_modules",
    ]);
  });

  it("joins the subpath for python too (site under the pip-FOD's $out)", () => {
    const python: SandboxStaging = { stageDir: "site", storeSubpath: "site", env: noEnv };
    expect(stageCommands(python, STORE)).toEqual([
      "chmod -R u+w site 2>/dev/null; rm -rf site",
      `cp -RL ${STORE}/site site`,
      "chmod -R u+w site",
    ]);
  });

  it("copies the WHOLE depsStorePath when there is no subpath (go's vendor)", () => {
    // Go's deps Store path IS the vendor dir, so the source is depsStorePath itself
    // — no trailing `/subpath`.
    const go: SandboxStaging = { stageDir: "vendor", storeSubpath: "", env: noEnv };
    expect(stageCommands(go, STORE)).toEqual([
      "chmod -R u+w vendor 2>/dev/null; rm -rf vendor",
      `cp -RL ${STORE} vendor`,
      "chmod -R u+w vendor",
    ]);
  });
});
