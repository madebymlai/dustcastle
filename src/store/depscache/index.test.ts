import { describe, expect, it } from "vitest";
import {
  defaultDepsCacheDir,
  depsCacheDecision,
  depsCacheKey,
  depsCachePool,
  populateCommand,
  restoreCommand,
} from "./index.js";

// The deps-cache public face is the barrel at src/store/depscache/index.ts.
describe("depscache barrel", () => {
  it("exports the run-facing and GC-facing cache API from one module", () => {
    expect(typeof depsCacheDecision).toBe("function");
    expect(typeof depsCacheKey).toBe("function");
    expect(typeof populateCommand).toBe("function");
    expect(typeof restoreCommand).toBe("function");
    expect(typeof defaultDepsCacheDir).toBe("function");
    expect(typeof depsCachePool).toBe("function");
  });
});
