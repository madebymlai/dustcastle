import { describe, expect, it } from "vitest";
import { generateNodeBuild } from "./node.js";

// The Node importer (ADR 0004): emits the Nix expression that fixed-output-
// fetches the lockfile deps (hash-pinned) into the Store, then runs real
// `npm ci --offline` against that cache — "Nix-built still uses npm". Same
// NixBuild contract as Go. These tests pin the structure the store relies on;
// the live build is proven by the gated Node e2e.

describe("generateNodeBuild (ADR 0004 Node importer)", () => {
  it("names the toolchain, deps, and app attributes the store realizes", () => {
    const build = generateNodeBuild({
      pname: "app",
      npmDepsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.attrs).toEqual({ toolchain: "nodejs", deps: "deps", app: "app" });
  });

  it("fetches deps with buildNpmPackage, hash-pinned by npmDepsHash (ADR 0004)", () => {
    const npmDepsHash = "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=";
    const build = generateNodeBuild({ pname: "app", npmDepsHash });

    expect(build.expression).toContain("buildNpmPackage");
    expect(build.expression).toContain('pname = "app-deps"');
    // The lockfile is genuinely enforced: a wrong hash fails the build.
    expect(build.expression).toContain(`npmDepsHash = "${npmDepsHash}"`);
  });

  it("never runs untrusted lifecycle scripts during the pure provision build", () => {
    // ADR 0004/0005: provisioning is pure and offline, so `postinstall` is
    // skipped — untrusted code runs only later, in the container under scoped
    // egress. --ignore-scripts is what makes nix-portable's lack of a build
    // sandbox irrelevant to safety (the slice-2 open question).
    const build = generateNodeBuild({
      pname: "app",
      npmDepsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).toContain("--ignore-scripts");
  });
});
