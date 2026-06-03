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
        classifyLine: (line) => (line.startsWith("building") ? "info" : "debug"),
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

  // Regression (dustcastle-muw): podman writes its STEP progress to STDOUT, not
  // stderr — so streaming only stderr left image builds silent. The classifier must
  // apply to stdout too.
  it("logs a STDOUT line live (podman-style progress lands on stdout)", async () => {
    const logger = createMemoryLogger();

    const result = await runStreamingAsync(
      process.execPath,
      [
        "-e",
        "process.stdout.write('STEP 1/4: FROM node:20-alpine\\n'); setTimeout(() => process.exit(0), 50);",
      ],
      {
        logger,
        label: "podman",
        classifyLine: (line) => (line.startsWith("STEP") ? "info" : "debug"),
      },
    );

    expect(result.stdout).toContain("STEP 1/4"); // still accumulated for parsing/error-tails
    expect(logger.records.some((r) => r.fields.line === "STEP 1/4: FROM node:20-alpine")).toBe(true);
  });
});
