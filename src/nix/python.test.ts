import { describe, expect, it } from "vitest";
import { generatePythonBuild } from "./python.js";

// The Python pip-FOD Importer (ADR 0006 amendment): emits the Nix expression that
// downloads the hash-pinned wheelhouse (one network step, `pythonDepsHash`) into
// the Store, then runs real `pip install --no-index` against it — pure, offline
// assembly (wheels run no code). Same NixBuild contract as Go/Node. These tests
// pin the structure the store relies on; the live build is proven by the gated
// Python e2e.

describe("generatePythonBuild (ADR 0006 pip-FOD Importer)", () => {
  it("names the toolchain, deps, and app attributes the store realizes", () => {
    const build = generatePythonBuild({
      pname: "app",
      pythonDepsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.attrs).toEqual({ toolchain: "python", deps: "deps", app: "app" });
  });

  it("downloads the wheelhouse via pip download, hash-pinned by pythonDepsHash (ADR 0004)", () => {
    const pythonDepsHash = "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=";
    const build = generatePythonBuild({ pname: "app", pythonDepsHash });

    // (1) The network-ON FOD download step.
    expect(build.expression).toContain("pip download");
    // wheels-only, deterministic — no build during download.
    expect(build.expression).toContain("--only-binary=:all:");
    // the lockfile's own hashes are honoured.
    expect(build.expression).toContain("--require-hashes");
    // The single aggregate output hash genuinely enforces the lockfile: a wrong
    // hash fails the build.
    expect(build.expression).toContain(`outputHash = "${pythonDepsHash}"`);
  });

  it("assembles deps offline with pip install --no-index --find-links (ADR 0006a)", () => {
    const build = generatePythonBuild({
      pname: "app",
      pythonDepsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    // (2) The network-ISOLATED offline assembly step: only the FOD wheelhouse.
    expect(build.expression).toContain("pip install");
    expect(build.expression).toContain("--no-index");
    expect(build.expression).toContain("--find-links=");
  });

  it("emits self-contained nixpkgs via fetchTarball — no external flake inputs (ADR 0001/0006)", () => {
    const build = generatePythonBuild({
      pname: "app",
      pythonDepsHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(build.expression).toContain("builtins.fetchTarball");
    // Not uv2nix / poetry2nix (external flake inputs would break the invariant).
    expect(build.expression).not.toContain("uv2nix");
    expect(build.expression).not.toContain("poetry2nix");
  });
});
