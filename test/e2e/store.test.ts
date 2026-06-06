import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detect } from "../../src/detect/index.js";
import { physPath, provisionStore, type Provisioned } from "../../src/store/index.js";
import { completeMarker, depsCacheDecision } from "../../src/store/depscache/index.js";
import { planSandbox } from "../../src/sandbox/plan.js";
import { stageSampleProject } from "./fixture.js";

// Integration: realize a real Go project into the rootless Store via nix-portable
// (ADR 0008/0012). Under ADR 0012 the Store realizes ONLY the Toolchain — Project
// Deps install in-Sandbox via the sandcastle hook, so there is no deps FOD here.
// Gated behind DUSTCASTLE_E2E=1 — the bare unit suite stays fast.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("provisionStore (toolchain-only rootless Store, ADR 0008/0012)", () => {
  e2e("realizes ONLY the Go Toolchain — no deps FOD in the Store", async () => {
    const root = mkdtempSync(join(tmpdir(), "dustcastle-e2e-"));
    tmps.push(root);
    const projectDir = stageSampleProject(root);

    const detection = detect(projectDir)[0];
    expect(detection?.packageManager).toBe("go");

    const provisioned = await provisionStore({ projectDir, detection: detection! });

    // The Toolchain lands as a content-addressed path.
    expect(provisioned.toolchainStorePath).toMatch(/^\/nix\/store\/.+-go-\d/);
    // ADR 0012: the Store holds ONLY the Toolchain — deps install in-Sandbox, so there
    // is no deps FOD path. The active rootless runtime is surfaced (ADR 0008), and
    // the Toolchain path resolves to real files under the physical store root.
    expect(provisioned.mode).toBe("bwrap");
    expect(existsSync(physPath(provisioned.physStoreRoot, provisioned.toolchainStorePath))).toBe(true);
  });
});

// A toolchain-only provisioned stub (deps install in-Sandbox), for the pure plan
// assertions below — no nix/podman needed.
function toolchainOnly(): Provisioned {
  return {
    mode: "bwrap",
    physStoreRoot: "/phys",
    toolchainStorePath: "/nix/store/aaaa-node",
  };
}

describe("deps cache (ADR 0016) — keyed by deps fingerprint", () => {
  // A pure exercise of the host-side cache decision + the plan hooks it drives: no
  // Store/Sandbox needed, so it runs in the bare suite too. The heavy in-Sandbox
  // restore/install is exercised by the run-tests above (node-run et al.).
  it("misses (installs + populates) until the deps-key entry exists, then hits (restores)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-depscache-"));
    tmps.push(dir);
    const cacheDir = join(dir, "cache");
    const projectDir = join(dir, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
    writeFileSync(join(projectDir, "package-lock.json"), JSON.stringify({ name: "p", lockfileVersion: 3 }));

    const detection = detect(projectDir)[0]!;
    expect(detection.ecosystem).toBe("node");

    // MISS: a deps fingerprint is present but no assembled entry on disk yet.
    const miss = depsCacheDecision(projectDir, detection, cacheDir);
    expect(miss.depsKey).toBeTruthy();
    expect(miss.hit).toBe(false);

    // On a MISS the plan installs in-Sandbox (`npm install`) and schedules a populate;
    // nothing is restored on the host. (A committed lockfile is still honoured by the
    // resolving install — and a lock-grade repo still caches by its deps key.)
    const missPlan = planSandbox({ ecosystems: [{ provisioned: toolchainOnly(), detection, cache: miss }], cacheDir });
    expect(missPlan.setupCommands.join("\n")).toContain("npm install");
    expect(missPlan.hostWorktreeReady).toEqual([]);
    expect(missPlan.populate).toHaveLength(1);
    expect(missPlan.populate[0]!.depsKey).toBe(miss.depsKey);

    // Populate the deps-key entry → the decision flips to a HIT.
    mkdirSync(join(cacheDir, miss.depsKey, "node_modules"), { recursive: true });
    writeFileSync(completeMarker(cacheDir, miss.depsKey), "");
    const hit = depsCacheDecision(projectDir, detection, cacheDir);
    expect(hit.hit).toBe(true);

    // On a HIT the plan restores from the cache on the host (host.onWorktreeReady),
    // runs no install (`npm install` absent — just the git-exclude), and no populate.
    const hitPlan = planSandbox({ ecosystems: [{ provisioned: toolchainOnly(), detection, cache: hit }], cacheDir });
    expect(hitPlan.hostWorktreeReady.join("\n")).toContain(join(cacheDir, hit.depsKey));
    expect(hitPlan.setupCommands.join("\n")).not.toContain("npm install");
    expect(hitPlan.populate).toEqual([]);
  });
});
