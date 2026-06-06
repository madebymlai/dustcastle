import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAuthMounts,
  buildPiAgent,
  globalConfigPath,
  loadHandoff,
  loadModelSelection,
  writeModel,
} from "./global.js";

// The **global** dustcastle config (~/.dustcastle/config.json): one agent model
// every project shares (no project-local config). `dir` is injected at a throwaway
// temp path so tests never touch the real ~/.dustcastle. Pure FS — no pi, no podman.

const dirs: string[] = [];
function home(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-home-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const cfg = (dir: string, obj: unknown): void =>
  writeFileSync(globalConfigPath(dir), JSON.stringify(obj));

describe("writeModel / loadModelSelection (the global model choice)", () => {
  it("returns undefined when nothing is configured", () => {
    expect(loadModelSelection(home())).toBeUndefined();
  });

  it("round-trips a written model, creating the config", () => {
    const dir = home();
    writeModel("deepseek/deepseek-v4-pro", { dir });
    expect(loadModelSelection(dir)).toEqual({ model: "deepseek/deepseek-v4-pro" });
  });

  it("persists the model to ~/.dustcastle/config.json as readable JSON", () => {
    const dir = home();
    writeModel("deepseek/deepseek-v4-pro", { thinking: "high", dir });
    const onDisk = JSON.parse(readFileSync(globalConfigPath(dir), "utf8"));
    expect(onDisk).toMatchObject({ model: "deepseek/deepseek-v4-pro", thinking: "high" });
  });

  it("preserves other keys when re-picking the model", () => {
    const dir = home();
    cfg(dir, { model: "old/one", prompt: "do the task", maxIterations: 50 });
    writeModel("new/two", { dir });
    const onDisk = JSON.parse(readFileSync(globalConfigPath(dir), "utf8"));
    expect(onDisk).toEqual({ model: "new/two", prompt: "do the task", maxIterations: 50 });
  });

  it("rejects an empty model", () => {
    expect(() => writeModel("  ", { dir: home() })).toThrow(/non-empty/);
  });

  it("rejects an invalid thinking level", () => {
    expect(() => writeModel("m", { thinking: "turbo", dir: home() })).toThrow(/thinking/);
  });

  it("throws on malformed JSON", () => {
    const dir = home({ "config.json": "{ not json" });
    expect(() => loadModelSelection(dir)).toThrow(/not valid JSON/);
  });
});

describe("buildPiAgent / agentAuthMounts", () => {
  it("builds the pi agent (the only supported agent)", () => {
    expect(buildPiAgent({ model: "deepseek/deepseek-v4-pro" }).name).toBe("pi");
  });

  it("mounts the pi login dir (~/.pi/agent) into the sandbox", () => {
    // Matches agentstack: host ~/.pi/agent → sandbox ~/.pi/agent, read-write.
    expect(agentAuthMounts()).toEqual([{ hostPath: "~/.pi/agent", sandboxPath: "~/.pi/agent" }]);
  });
});

describe("loadHandoff (model + task → SandcastleHandoff)", () => {
  it("is undefined when no model is configured", () => {
    expect(loadHandoff(home())).toBeUndefined();
  });

  it("is undefined when a model is set but there is no task prompt (provision-only)", () => {
    const dir = home();
    cfg(dir, { model: "deepseek/deepseek-v4-pro" });
    expect(loadHandoff(dir)).toBeUndefined();
  });

  it("builds a pi handoff from model + inline prompt", () => {
    const dir = home();
    cfg(dir, { model: "deepseek/deepseek-v4-pro", prompt: "do the task", maxIterations: 100 });
    const h = loadHandoff(dir);
    expect(h?.agent.name).toBe("pi");
    expect(h?.prompt).toBe("do the task");
    expect(h?.maxIterations).toBe(100);
  });

  it("resolves a relative promptFile against ~/.dustcastle and passes hooks through", () => {
    const dir = home();
    cfg(dir, {
      model: "m",
      promptFile: "task.md",
      hooks: { onSandboxReady: ["npm install"] },
    });
    const h = loadHandoff(dir);
    expect(h?.promptFile).toBe(resolve(dir, "task.md"));
    expect(h?.hooks).toEqual({ sandbox: { onSandboxReady: [{ command: "npm install" }] } });
  });

  it("rejects both prompt and promptFile", () => {
    const dir = home();
    cfg(dir, { model: "m", prompt: "x", promptFile: "y.md" });
    expect(() => loadHandoff(dir)).toThrow(/at most one/);
  });
});

