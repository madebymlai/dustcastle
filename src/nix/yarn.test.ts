import { describe, expect, it } from "vitest";
import { generateYarnBuild } from "./yarn.js";

// The yarn importer (ADR 0004) — slice 2b, targeting Yarn v1 (classic
// `yarn.lock`). Same NixBuild contract as the npm/pnpm importers (toolchain
// "nodejs" + deps + app), so the store dispatches it through the shared JS
// provision path. `fetchYarnDeps` fixed-output-fetches the offline cache (hash-
// pinned by `depsHash`, the one network step); `yarnConfigHook` then runs an
// OFFLINE `yarn install` to assemble node_modules into the Store. These tests pin
// the structure the store relies on; the live build is proven by the gated yarn e2e.

describe("generateYarnBuild (ADR 0004 yarn importer)", () => {
  it("names the toolchain, deps, and app attributes the store realizes", () => {
    const build = generateYarnBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.attrs).toEqual({ toolchain: "nodejs", deps: "deps", app: "app" });
  });

  it("fetches the offline cache with fetchYarnDeps, hash-pinned by depsHash (ADR 0004)", () => {
    const depsHash = "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=";
    const build = generateYarnBuild({ pname: "app", depsHash });

    expect(build.expression).toContain("fetchYarnDeps");
    expect(build.expression).toContain("yarnConfigHook");
    expect(build.expression).toContain('pname = "app-deps"');
    // The offline cache is keyed off the repo's yarn.lock — the lockfile is the FOD input.
    expect(build.expression).toContain("yarn.lock");
    // The lockfile is genuinely enforced: a wrong hash fails the fixed-output fetch.
    expect(build.expression).toContain(`hash = "${depsHash}"`);
  });

  it("stays pure by only assembling with yarnConfigHook — no build hook runs scripts", () => {
    // ADR 0004/0005: yarnConfigHook populates node_modules from the offline cache
    // WITHOUT running package build/lifecycle scripts — those run in yarnBuildHook,
    // which we deliberately omit. So untrusted code never runs during provisioning;
    // it runs only later, in the container under scoped egress.
    const build = generateYarnBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).not.toContain("yarnBuildHook");
  });

  it("publishes node_modules itself as the deps store path", () => {
    const build = generateYarnBuild({
      pname: "app",
      depsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).toContain('cp -R node_modules "$out/node_modules"');
  });
});
