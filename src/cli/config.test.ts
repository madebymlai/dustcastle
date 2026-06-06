import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globalConfigPath, loadCredentialValues, loadModelSelection } from "../config/global.js";
import { runConfigHub } from "./config.js";
import { EXIT_FAILURE, EXIT_SUCCESS } from "./exit-codes.js";
import type { PiModelOption } from "./pi-models.js";
import { InMemoryTerminal } from "./terminal.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "dustcastle-config-test-"));
}

function models(entries: Record<string, readonly PiModelOption[]>): Map<string, PiModelOption[]> {
  return new Map(Object.entries(entries).map(([provider, opts]) => [provider, [...opts]]));
}

const ONE_PROVIDER = models({
  beta: [
    { label: "Beta One (32K)", value: "beta/one" },
    { label: "Beta Two (64K)", value: "beta/two" },
  ],
});

describe("runConfigHub", () => {
  it("dispatches the model action through the shared model picker and writes the global config", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    let fetched = false;
    const code = runConfigHub(
      term,
      () => {
        fetched = true;
        return ONE_PROVIDER;
      },
      dir,
    );

    term.feed("\r");
    await Promise.resolve();
    term.feed("\r");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(fetched).toBe(true);
    expect(loadModelSelection(dir)?.model).toBe("beta/one");
    expect(term.output).toContain("Dustcastle config");
    expect(term.output).toContain("Model: choose the pi agent model");
    expect(term.errorOutput).toContain("model set to beta/one");
  });

  it("cancels the hub without writing or returning an interrupt exit", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => ONE_PROVIDER, dir);

    term.feed("\x03");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(loadModelSelection(dir)).toBeUndefined();
  });

  it("cancels the model action without modifying existing config or returning an interrupt exit", async () => {
    const dir = tempHome();
    const original = { model: "old/model", prompt: "keep me" };
    writeFileSync(globalConfigPath(dir), JSON.stringify(original, null, 2) + "\n");
    const before = readFileSync(globalConfigPath(dir), "utf8");
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => ONE_PROVIDER, dir);

    term.feed("\r");
    await Promise.resolve();
    term.feed("\x03");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(readFileSync(globalConfigPath(dir), "utf8")).toBe(before);
    expect(loadModelSelection(dir)?.model).toBe("old/model");
  });

  it("lists credential descriptors and writes a filled GitHub token without clobbering config", async () => {
    const dir = tempHome();
    writeFileSync(globalConfigPath(dir), JSON.stringify({ model: "old/model", prompt: "keep" }, null, 2) + "\n");
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => ONE_PROVIDER, dir);

    term.feed("\x1b[B");
    term.feed("\r");
    await Promise.resolve();
    term.feed("\r");
    await Promise.resolve();
    term.feed("ghp_secret\r");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(term.output).toContain("Credentials: configure sandbox credentials");
    expect(term.output).toContain("GitHub: Personal Access Token");
    expect(term.output).toContain("GitLab: Personal Access Token");
    // The picker shows what it is + where to get it, never the internal env var name.
    expect(term.output).not.toContain("GITHUB_TOKEN");
    expect(term.output).not.toContain("GITLAB_TOKEN");
    expect(term.output).toContain("ghp_secret"); // echoed so the user can verify the paste
    expect(term.errorOutput).toContain("GitHub token saved");
    expect(loadModelSelection(dir)?.model).toBe("old/model");
    expect(loadCredentialValues(dir)).toEqual({ GITHUB_TOKEN: "ghp_secret" });
    expect(JSON.parse(readFileSync(globalConfigPath(dir), "utf8"))).toMatchObject({
      model: "old/model",
      prompt: "keep",
      credentials: { GITHUB_TOKEN: "ghp_secret" },
    });
  });

  it("writes a filled GitLab token from the credentials catalog", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => ONE_PROVIDER, dir);

    term.feed("\x1b[B");
    term.feed("\r");
    await Promise.resolve();
    term.feed("\x1b[B");
    term.feed("\r");
    await Promise.resolve();
    term.feed("glpat_secret\r");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(term.output).toContain("GitLab: Personal Access Token");
    expect(term.output).toContain("glpat_secret"); // echoed so the user can verify the paste
    expect(term.output).not.toContain("GITLAB_TOKEN");
    expect(term.errorOutput).toContain("GitLab token saved");
    expect(loadCredentialValues(dir)).toEqual({ GITLAB_TOKEN: "glpat_secret" });
  });

  it("returns success when the credentials action is cancelled without writing", async () => {
    const dir = tempHome();
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => ONE_PROVIDER, dir);

    term.feed("\x1b[B");
    term.feed("\r");
    await Promise.resolve();
    term.feed("\x03");

    await expect(code).resolves.toBe(EXIT_SUCCESS);
    expect(loadCredentialValues(dir)).toEqual({});
  });

  it("returns failure without fetching models when the terminal is not interactive", async () => {
    const term = new InMemoryTerminal({ rows: 12, isTTY: false });
    let fetched = false;

    await expect(
      runConfigHub(term, () => {
        fetched = true;
        return ONE_PROVIDER;
      }),
    ).resolves.toBe(EXIT_FAILURE);

    expect(fetched).toBe(false);
    expect(term.errorOutput).toContain("needs an interactive terminal");
  });

  it("returns failure with the pi login hint when the model action finds no models", async () => {
    const term = new InMemoryTerminal({ rows: 12 });
    const code = runConfigHub(term, () => new Map());

    term.feed("\r");

    await expect(code).resolves.toBe(EXIT_FAILURE);
    expect(term.errorOutput).toContain("Run `pi` then `/login` to authenticate");
  });
});
