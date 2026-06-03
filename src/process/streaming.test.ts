import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { runStreamingAsync } from "./streaming.js";

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runStreamingAsync", () => {
  it("logs a stderr line before the child closes while still accumulating stdout and stderr", async () => {
    const logger = createMemoryLogger();
    let settled = false;

    const run = runStreamingAsync(
      process.execPath,
      [
        "-e",
        "process.stdout.write('/nix/store/abc-toolchain\\n'); process.stderr.write('building toolchain\\n'); setTimeout(() => process.exit(0), 150);",
      ],
      {
        logger,
        label: "nix-build",
        classifyStderrLine: (line) => (line.startsWith("building") ? "info" : "debug"),
      },
    ).finally(() => {
      settled = true;
    });

    await waitUntil(() => logger.records.some((record) => record.fields.line === "building toolchain"));
    expect(settled).toBe(false);

    const result = await run;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("/nix/store/abc-toolchain");
    expect(result.stderr).toContain("building toolchain");
    expect(logger.records.find((record) => record.fields.line === "building toolchain")?.level).toBe("info");
  });
});
