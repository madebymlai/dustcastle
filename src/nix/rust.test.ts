import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME, generateRustBuild } from "./rust.js";

// Rust's Cargo Importer (dustcastle-gy5.2): a fetchCargoVendor FOD discovers one
// aggregate cargoHash, then the deps derivation rebases Cargo's shipped config to
// a relocatable CARGO_HOME basename so the Sandbox can stage deps with the same
// env-only cp -RL path as Go.

describe("generateRustBuild (Cargo importer, dustcastle-gy5.2)", () => {
  it("emits the attrs the store realizes", () => {
    const build = generateRustBuild({
      pname: "sample",
      cargoHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });

    expect(build.attrs).toEqual({ toolchain: "toolchain", deps: "deps", app: "app" });
  });

  it("pins Cargo deps with one aggregate cargoHash and rebases @vendor@ to the CARGO_HOME basename", () => {
    const cargoHash = "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=";
    const build = generateRustBuild({ pname: "sample", cargoHash });

    expect(build.expression).toContain("fetchCargoVendor");
    expect(build.expression).toContain(`cargoHash = "${cargoHash}"`);
    expect(build.expression).toContain("hash = cargoHash");
    expect(build.expression).toContain(`s|@vendor@|${CARGO_HOME_BASENAME}/vendor|g`);
  });

  it("runs cargo test fully offline against staged deps", () => {
    const build = generateRustBuild({
      pname: "sample",
      cargoHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });

    expect(build.expression).toContain(`export CARGO_HOME="$TMPDIR/${CARGO_HOME_BASENAME}"`);
    expect(build.expression).toContain("export CARGO_NET_OFFLINE=true");
    expect(build.expression).toContain("cargo test --offline --frozen");
    expect(build.expression).toContain("pkgs.cc");
  });
});
