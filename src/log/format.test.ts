import { describe, expect, it } from "vitest";
import { messageFormat } from "./format.js";

describe("messageFormat", () => {
  it("renders swept events as the next-run sweep line", () => {
    expect(messageFormat({ event: "swept", line: "1700000000000 last sweep freed 4300 bytes (2 path(s) collected)" })).toBe(
      "🧹 dustcastle: 1700000000000 last sweep freed 4300 bytes (2 path(s) collected)",
    );
  });

  it("renders ordinary records as the bare message (mod stays out of the console)", () => {
    // `mod` is implementation detail — it never reaches the console message; only msg does.
    expect(messageFormat({ mod: "gc", msg: "collecting" })).toBe("collecting");
    expect(messageFormat({ msg: "hello" })).toBe("hello");
  });
});
