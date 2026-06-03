import { describe, expect, it } from "vitest";
import { proxyLoggerOptions } from "./proxy-logger.js";

describe("proxyLoggerOptions", () => {
  it("configures proxy stderr JSON with no flight-recorder file target", () => {
    expect(proxyLoggerOptions()).toEqual({ level: "trace", base: null });
  });
});
