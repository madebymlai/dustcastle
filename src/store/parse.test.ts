import { describe, expect, it } from "vitest";
import { parseStorePath, parseVendorHashMismatch } from "./parse.js";

// ADR 0004: the vendor FOD is hash-pinned, so a wrong hash fails the build and
// Nix reports the real one. v1 ships no dynamic-derivations, so the store
// discovers the hash by building once with a placeholder and reading it back.

describe("parseVendorHashMismatch (ADR 0004 hash discovery)", () => {
  const mismatch = [
    "error: hash mismatch in fixed-output derivation '/nix/store/q1-sample-0.0.0-go-modules.drv':",
    "         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "            got:    sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=",
  ].join("\n");

  it("extracts the correct hash Nix reports as `got`", () => {
    expect(parseVendorHashMismatch(mismatch)).toBe(
      "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=",
    );
  });

  it("returns undefined when the output is not a hash mismatch", () => {
    expect(parseVendorHashMismatch("error: build of go test failed")).toBeUndefined();
  });
});

describe("parseStorePath", () => {
  it("reads the realized /nix/store path nix-build prints on stdout", () => {
    expect(parseStorePath("/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-go-1.26.3\n")).toBe(
      "/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-go-1.26.3",
    );
  });

  it("throws if nix-build produced no store path", () => {
    expect(() => parseStorePath("")).toThrow();
  });
});
