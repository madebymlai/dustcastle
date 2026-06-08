import { describe, expect, it, vi } from "vitest";
import { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE } from "./exit-codes.js";
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

  it("exits with the config hint when no model is configured, without provisioning", async () => {
    const term = new InMemoryTerminal({ isTTY: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const exitCode = await runCli(["run"], {
        terminal: () => term,
        ensureModel: async () => "proceed",
        loadModelSelection: () => undefined,
      });
      expect(exitCode).toBe(EXIT_FAILURE);
      expect(error).toHaveBeenCalledWith("dustcastle: no model configured — run `dustcastle config`");
    } finally {
      error.mockRestore();
    }
  });

  it("exits with EXIT_FAILURE in headless mode when no model is configured", async () => {
    const term = new InMemoryTerminal({ isTTY: false });
    const exitCode = await runCli(["run"], {
      terminal: () => term,
      ensureModel: async (t) => {
        t.error("dustcastle: no model configured — run `dustcastle config`\n");
        return "no-model";
      },
    });
    expect(exitCode).toBe(EXIT_FAILURE);
    expect(term.errorOutput).toContain("no model configured — run `dustcastle config`");
  });

  it("parses --dustless from run args and passes dustless:true to orchestrate", async () => {
    const term = new InMemoryTerminal({ isTTY: true });
    let receivedDustless: boolean | undefined;
    const orchestrate = vi.fn(async (opts: { dustless?: boolean }) => {
      receivedDustless = opts.dustless;
    });

    await expect(
      runCli(["run", "--dustless"], {
        terminal: () => term,
        ensureModel: async () => "proceed",
        loadModelSelection: () => ({ model: "test/model" }),
        orchestrate,
      }),
    ).resolves.toBe(EXIT_SUCCESS);

    expect(receivedDustless).toBe(true);
  });

  it("parses -d from run args and passes dustless:true to orchestrate", async () => {
    const term = new InMemoryTerminal({ isTTY: true });
    let receivedDustless: boolean | undefined;
    const orchestrate = vi.fn(async (opts: { dustless?: boolean }) => {
      receivedDustless = opts.dustless;
    });

    await expect(
      runCli(["run", "-d"], {
        terminal: () => term,
        ensureModel: async () => "proceed",
        loadModelSelection: () => ({ model: "test/model" }),
        orchestrate,
      }),
    ).resolves.toBe(EXIT_SUCCESS);

    expect(receivedDustless).toBe(true);
  });

  it("passes dustless:false to orchestrate when no dustless flag is given", async () => {
    const term = new InMemoryTerminal({ isTTY: true });
    let receivedDustless: boolean | undefined;
    const orchestrate = vi.fn(async (opts: { dustless?: boolean }) => {
      receivedDustless = opts.dustless;
    });

    await expect(
      runCli(["run"], {
        terminal: () => term,
        ensureModel: async () => "proceed",
        loadModelSelection: () => ({ model: "test/model" }),
        orchestrate,
      }),
    ).resolves.toBe(EXIT_SUCCESS);

    expect(receivedDustless).toBe(false);
  });
});
