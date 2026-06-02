import { describe, expect, it } from "vitest";
import { defaultDepsCacheDir, depsCacheKey, depsCachePool, populateCacheCommand } from "./index.js";

// The deps-cache public face is the barrel at src/store/depscache/index.ts.
describe("depscache barrel", () => {
  it("exports the run-facing and GC-facing cache API from one module", () => {
    expect(typeof depsCacheKey).toBe("function");
    expect(typeof populateCacheCommand).toBe("function");
    expect(typeof defaultDepsCacheDir).toBe("function");
    expect(typeof depsCachePool).toBe("function");
  });
});
