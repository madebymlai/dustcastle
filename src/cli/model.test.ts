import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModelSelection, writeModel } from "../config/global.js";
import { chooseModel, ensureModel, runModelCommand } from "./model.js";
import type { PiModelOption } from "./pi-models.js";
import { InMemoryTerminal } from "./terminal.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dustcastle-model-test-"));
}

function models(entries: Record<string, readonly PiModelOption[]>): Map<string, PiModelOption[]> {
  return new Map(Object.entries(entries).map(([provider, opts]) => [provider, [...opts]]));
}

const TWO_PROVIDERS = models({
  alpha: [{ label: "Alpha Small (8K)", value: "alpha/small" }],
  beta: [
    { label: "Beta One (32K)", value: "beta/one" },
    { label: "Beta Two (64K)", value: "beta/two" },
  ],
});

const ONE_PROVIDER = models({
  beta: [
    { label: "Beta One (32K)", value: "beta/one" },
    { label: "Beta Two (64K)", value: "beta/two" },
  ],
});

describe("chooseModel", () => {
  it("picks provider first when multiple providers are available", async () => {
    const term = new InMemoryTerminal({ rows: 12 });
    const selected = chooseModel(TWO_PROVIDERS, term);

    term.feed("\x1b[B");
    term.feed("\r");
    await Promise.resolve();
    term.feed("\r");

    await expect(selected).resolves.toBe("beta/one");
  });

  it("skips the provider prompt when only one provider is available", async () => {
    const term = new InMemoryTerminal({ rows: 12 });
    const selected = chooseModel(ONE_PROVIDER, term);

    term.feed("\x1b[B");
    term.feed("\r");

    await expect(selected).resolves.toBe("beta/two");
    expect(term.output).not.toContain("Which provider?");
  });

  it("propagates picker cancellation without selecting a model", async () => {
    const term = new InMemoryTerminal({ rows: 12 });
    const selected = chooseModel(ONE_PROVIDER, term);

    term.feed("\x03");

    await expect(selected).resolves.toBeUndefined();
  });
});

describe("runModelCommand", () => {
  it("returns 0, writes the selected model, and reports the saved model", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runModelCommand(term, () => ONE_PROVIDER, dir);

    term.feed("\r");

    await expect(code).resolves.toBe(0);
    expect(loadModelSelection(dir)?.model).toBe("beta/one");
    expect(term.errorOutput).toContain("model set to beta/one");
  });

  it("returns 1 with the pi login hint when no models are available", async () => {
    const term = new InMemoryTerminal({ rows: 12 });

    await expect(runModelCommand(term, () => new Map())).resolves.toBe(1);
    expect(term.errorOutput).toContain("Run `pi` then `/login` to authenticate");
  });

  it("returns 1 without fetching models when the terminal is not fully interactive", async () => {
    const term = new InMemoryTerminal({ rows: 12, isTTY: false });
    let fetched = false;

    await expect(
      runModelCommand(
        term,
        () => {
          fetched = true;
          return ONE_PROVIDER;
        },
      ),
    ).resolves.toBe(1);

    expect(fetched).toBe(false);
    expect(term.errorOutput).toContain("needs an interactive terminal");
  });

  it("returns 130 on Ctrl-C without reporting no models", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runModelCommand(term, () => ONE_PROVIDER, dir);

    term.feed("\x03");

    await expect(code).resolves.toBe(130);
    expect(loadModelSelection(dir)).toBeUndefined();
    expect(term.errorOutput).not.toContain("no pi models found");
  });
});

describe("ensureModel", () => {
  it("returns proceed without fetching when a model already exists", async () => {
    const dir = tempHome();
    writeModel("beta/one", { dir });
    let fetched = false;

    await expect(
      ensureModel(
        new InMemoryTerminal({ rows: 12 }),
        () => {
          fetched = true;
          return ONE_PROVIDER;
        },
        dir,
      ),
    ).resolves.toBe("proceed");

    expect(fetched).toBe(false);
  });

  it("returns no-model without fetching or showing a picker when headless and unconfigured", async () => {
    const term = new InMemoryTerminal({ rows: 12, isTTY: false });
    let fetched = false;

    await expect(
      ensureModel(
        term,
        () => {
          fetched = true;
          return ONE_PROVIDER;
        },
        tempHome(),
      ),
    ).resolves.toBe("no-model");

    expect(fetched).toBe(false);
    expect(term.output).toBe("");
    expect(term.errorOutput).toContain("no model configured — run `dustcastle model`");
    expect(term.errorOutput).not.toContain("Run `pi` then `/login` to authenticate");
  });

  it("returns cancelled when the first-run picker is cancelled", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const outcome = ensureModel(term, () => ONE_PROVIDER, dir);

    term.feed("\x03");

    await expect(outcome).resolves.toBe("cancelled");
    expect(loadModelSelection(dir)).toBeUndefined();
  });

  it("returns proceed after the interactive no-models hint so the ADR 0009 provisioning path remains", async () => {
    const term = new InMemoryTerminal({ rows: 12 });

    await expect(ensureModel(term, () => new Map(), tempHome())).resolves.toBe("proceed");
    expect(term.errorOutput).toContain("Run `pi` then `/login` to authenticate");
  });
});
