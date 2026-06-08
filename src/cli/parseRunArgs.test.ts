import { describe, expect, it } from "vitest";
import { parseRunArgs } from "./parseRunArgs.js";

describe("parseRunArgs", () => {
  it("returns dustless:false when no dustless flag is present", () => {
    expect(parseRunArgs([])).toEqual({ dustless: false });
    expect(parseRunArgs(["some", "other", "args"])).toEqual({ dustless: false });
  });

  it("detects --dustless", () => {
    expect(parseRunArgs(["--dustless"])).toEqual({ dustless: true });
    expect(parseRunArgs(["some", "--dustless", "args"])).toEqual({ dustless: true });
  });

  it("detects -d", () => {
    expect(parseRunArgs(["-d"])).toEqual({ dustless: true });
    expect(parseRunArgs(["some", "-d", "args"])).toEqual({ dustless: true });
  });
});
