import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME, CARGO_VENDOR_DIR, generateRustBuild } from "./rust.js";

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
    expect(build.expression).toContain(`s|@vendor@|${CARGO_VENDOR_DIR}|g`);
  });

  it("rebases the shipped cargo config unconditionally — no hand-written fallback (ADR-0004a Rejected)", () => {
    const build = generateRustBuild({
      pname: "sample",
      cargoHash: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });

    // fetchCargoVendor always ships .cargo/config.toml with the complete source
    // mapping (incl. git sources); ADR-0004a rejects hand-writing a minimal config
    // because it risks dropping non-crates.io sources. The importer must only rebase
    // the shipped config, never synthesize a fallback.
    expect(build.expression).toContain(`s|@vendor@|${CARGO_VENDOR_DIR}|g`);
    expect(build.expression).not.toContain("[source.crates-io]");
    expect(build.expression).not.toContain('replace-with = "vendored-sources"');
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
