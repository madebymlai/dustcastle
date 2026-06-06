import { describe, expect, it, vi } from "vitest";
import { EXIT_SUCCESS, EXIT_USAGE } from "./exit-codes.js";
import { runCli, USAGE } from "./main.js";
import { InMemoryTerminal } from "./terminal.js";

describe("runCli command dispatch", () => {
  it("lists config rather than the removed standalone model command", () => {
    expect(USAGE).toContain("dustcastle config");
    expect(USAGE).not.toContain("dustcastle model");
  });

  it("dispatches dustcastle config to the config hub", async () => {
    const term = new InMemoryTerminal();
    const runConfig = vi.fn(async () => EXIT_SUCCESS);

    await expect(runCli(["config"], { terminal: () => term, runConfig })).resolves.toBe(EXIT_SUCCESS);

    expect(runConfig).toHaveBeenCalledWith(term);
  });

  it("rejects the removed standalone dustcastle model command", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runCli(["model"])).resolves.toBe(EXIT_USAGE);
      expect(error.mock.calls[0]?.[0]).toContain("unknown command 'model'");
    } finally {
      error.mockRestore();
    }
  });
});
