import { describe, expect, it } from "vitest";
import { generatePnpmBuild } from "./pnpm.js";

// The pnpm importer (ADR 0004) — slice 2b. Same NixBuild contract as the npm
// importer (toolchain "nodejs" + deps + app), so the store dispatches it through
// the shared JS provision path. It fixed-output-fetches the pnpm store (hash-
// pinned by `depsHash`, the one network step) via `fetchPnpmDeps`, then runs an
// OFFLINE `pnpm install --ignore-scripts` (pnpmConfigHook) to assemble
// node_modules into the Store. These tests pin the structure the store relies on;
// the live build is proven by the gated pnpm e2e.

describe("generatePnpmBuild (ADR 0004 pnpm importer)", () => {
  it("names the toolchain, deps, and app attributes the store realizes", () => {
    const build = generatePnpmBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    // Identical contract to the npm importer: the store's shared JS provision
    // path realizes nodejs/deps/app by these names regardless of manager.
    expect(build.attrs).toEqual({ toolchain: "nodejs", deps: "deps", app: "app" });
  });

  it("fetches the pnpm store with fetchPnpmDeps, hash-pinned by depsHash (ADR 0004)", () => {
    const depsHash = "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=";
    const build = generatePnpmBuild({ pname: "app", depsHash });

    expect(build.expression).toContain("fetchPnpmDeps");
    expect(build.expression).toContain("pnpmConfigHook");
    expect(build.expression).toContain('pname = "app-deps"');
    // The lockfile is genuinely enforced: a wrong hash fails the fixed-output fetch.
    expect(build.expression).toContain(`hash = "${depsHash}"`);
    // Pin the store format with the current fetcher version (ADR 0004 reproducibility).
    expect(build.expression).toContain("fetcherVersion = 3");
  });

  it("never runs untrusted lifecycle scripts during the pure provision build", () => {
    // ADR 0004/0005: provisioning is pure and offline, so dependency lifecycle
    // scripts are skipped — untrusted code runs only later, in the container under
    // scoped egress. pnpmConfigHook runs a real `pnpm install`, so --ignore-scripts
    // is what makes nix-portable's lack of a build sandbox irrelevant to safety.
    const build = generatePnpmBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).toContain("--ignore-scripts");
  });

  it("publishes node_modules itself as the deps store path", () => {
    // The deps attr realizes the assembled node_modules as its own Store path,
    // which the Sandbox stages in (same as the npm importer — the plan's pure
    // setup copies <deps>/node_modules regardless of manager).
    const build = generatePnpmBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).toContain('cp -R node_modules "$out/node_modules"');
  });
});
