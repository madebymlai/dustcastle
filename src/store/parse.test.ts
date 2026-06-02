import { describe, expect, it } from "vitest";
import { parseStorePath, storeHashOf } from "./parse.js";

// The store realizes only the Toolchain now (ADR 0012, always-impure) — Project
// Deps install in-Sandbox — so the FOD hash-discovery parser is gone. `parseStorePath`
// reads the realized Toolchain store path from `nix-build --no-out-link` stdout.

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

describe("storeHashOf", () => {
  it("extracts the leading hash segment from a realized Store path", () => {
    expect(storeHashOf("/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-go-1.26.3")).toBe(
      "33fw5m31lfcnk4ff2f0df7j2bxnh8lgk",
    );
  });

  it("throws on malformed Store paths", () => {
    expect(() => storeHashOf("/tmp/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-go-1.26.3")).toThrow();
    expect(() => storeHashOf("/nix/store/hashonly")).toThrow();
    expect(() => storeHashOf("/nix/store/-go")).toThrow();
    expect(() => storeHashOf("/nix/store/33fw5m31lfcnk4ff2f0df7j2bxnh8lgk-go/bin")).toThrow();
  });
});
