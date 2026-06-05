import { describe, expect, it } from "vitest";
import { readRustToolchainToml, readRustToolchainVersion } from "./rust.js";

// Rust's Toolchain version reader (dustcastle-gy5.3) records an explicit rustup
// channel pin for detection/closure-keying, but it MUST NOT treat Cargo.toml's
// rust-version as a pin: rust-version is only the MSRV floor.

describe("readRustToolchainToml ([toolchain] channel parser)", () => {
  it.each([
    {
      raw: '[toolchain]\nchannel = "stable"\n',
      expected: "stable",
    },
    {
      raw: "[toolchain]\nchannel = 'nightly-2026-01-01' # comment\n",
      expected: "nightly-2026-01-01",
    },
    {
      raw: '[toolchain]\ncomponents = ["rustfmt"]\nchannel = "1.76.0"\n',
      expected: "1.76.0",
    },
    {
      raw: '[ toolchain ]\nchannel = "beta"\n',
      expected: "beta",
    },
  ])("reads $expected", ({ raw, expected }) => {
    expect(readRustToolchainToml(raw)).toBe(expected);
  });

  it.each([undefined, "", '[package]\nchannel = "stable"\n', '[toolchain]\ncomponents = ["rustfmt"]\n'])(
    "%o -> undefined",
    (raw) => {
      expect(readRustToolchainToml(raw)).toBeUndefined();
    },
  );
});

describe("readRustToolchainVersion (rust-toolchain.toml / legacy rust-toolchain)", () => {
  const readVersionFiles = (files: Record<string, string | undefined>) => (name: string) => files[name];

  it("reads rust-toolchain.toml [toolchain] channel first", () => {
    expect(
      readRustToolchainVersion({
        manifest: undefined,
        readVersionFile: readVersionFiles({
          "rust-toolchain.toml": '[toolchain]\nchannel = "1.76.0"\ncomponents = ["rustfmt"]\n',
          "rust-toolchain": "stable\n",
        }),
      }),
    ).toBe("1.76.0");
  });

  it("falls back to the legacy bare rust-toolchain file", () => {
    expect(
      readRustToolchainVersion({
        manifest: undefined,
        readVersionFile: readVersionFiles({ "rust-toolchain": "nightly-2026-01-01\n" }),
      }),
    ).toBe("nightly-2026-01-01");
  });

  it("does not read Cargo.toml rust-version as a Toolchain pin", () => {
    expect(
      readRustToolchainVersion({
        manifest: '[package]\nname = "sample"\nrust-version = "1.70"\n',
        readVersionFile: readVersionFiles({}),
      }),
    ).toBeUndefined();
  });

  it("returns undefined when neither Rust version file is present", () => {
    expect(
      readRustToolchainVersion({
        manifest: undefined,
        readVersionFile: readVersionFiles({}),
      }),
    ).toBeUndefined();
  });
});
