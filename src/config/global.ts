import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import type { SandcastleHandoff } from "../run/index.js";
import { PROVIDER_API_HOSTS } from "./provider-hosts.js";

// dustcastle's **global** config (ADR 0002). The agent model is a single global
// choice every project / every instance shares — there is no project-local config.
// `dustcastle model` writes the selection here; `dustcastle run` reads it anywhere.
// dustcastle drives the **pi** coding agent only: the user authenticates once on
// the host (`pi` → `/login`, stored in `~/.pi/agent`, mounted into the sandbox),
// and the model is pi's own `provider/model` selector (e.g. "deepseek/deepseek-v4-pro").
//
// Parsing is pure + total; the live agent run it feeds stays gated on a host `pi
// login` + a pi-equipped sandbox image.

/** The dustcastle-owned home dir (also holds `bin/nix-portable`). */
export const DUSTCASTLE_HOME = join(homedir(), ".dustcastle");
export const GLOBAL_CONFIG_FILE = "config.json";

/** Absolute path to the global config. `dir` is injectable for tests. */
export function globalConfigPath(dir: string = DUSTCASTLE_HOME): string {
  return join(dir, GLOBAL_CONFIG_FILE);
}

/** pi's reasoning-effort levels (`PiOptions.thinking`). */
const PI_THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type PiThinking = (typeof PI_THINKING)[number];

/** The chosen agent model (pi `provider/model`) plus its optional reasoning level. */
export interface ModelSelection {
  readonly model: string;
  readonly thinking?: PiThinking;
}

/** Read + JSON-parse the global config object, or `undefined` when none exists. */
export function readGlobalConfig(dir: string = DUSTCASTLE_HOME): Record<string, unknown> | undefined {
  const path = globalConfigPath(dir);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`invalid ~/.dustcastle/config.json: not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("invalid ~/.dustcastle/config.json: expected a JSON object");
  }
  return raw as Record<string, unknown>;
}

/** The configured model selection, or `undefined` when no model is set yet. */
export function loadModelSelection(dir: string = DUSTCASTLE_HOME): ModelSelection | undefined {
  const raw = readGlobalConfig(dir);
  if (raw === undefined) return undefined;
  if (typeof raw.model !== "string" || raw.model.trim() === "") return undefined;
  const thinking = parseThinking(raw.thinking);
  return { model: raw.model, ...(thinking !== undefined ? { thinking } : {}) };
}

/**
 * Persist the chosen model into the global config, preserving any other keys
 * (e.g. a configured prompt). Creates `~/.dustcastle/` as needed. `dir` injectable
 * for tests.
 */
export function writeModel(
  model: string,
  opts: { thinking?: string; dir?: string } = {},
): void {
  if (typeof model !== "string" || model.trim() === "") {
    throw new Error("model must be a non-empty pi model selector");
  }
  const dir = opts.dir ?? DUSTCASTLE_HOME;
  const existing = existsSync(globalConfigPath(dir)) ? readGlobalConfig(dir) ?? {} : {};
  const thinking = opts.thinking !== undefined ? parseThinking(opts.thinking) : undefined;
  const next: Record<string, unknown> = {
    ...existing,
    model,
    ...(thinking !== undefined ? { thinking } : {}),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * The model-provider API host(s) for a pi `provider/model` selector (ADR 0010 —
 * Agent Egress). The provider is the part before the first `/`; its hosts come
 * from the curated {@link PROVIDER_API_HOSTS} table. Throws — never silent (ADR
 * 0005) — when the selector is malformed or the provider has no mapped host: the
 * agent literally can't reach its LLM, so failing at plan time with an actionable
 * message beats a cryptic mid-run "Connection error".
 */
export function modelProviderHosts(model: string): readonly string[] {
  const provider = model.split("/")[0];
  if (provider === undefined || provider.length === 0) {
    throw new Error(`dustcastle: malformed model selector '${model}' — expected 'provider/model'`);
  }
  const hosts = PROVIDER_API_HOSTS[provider];
  if (hosts === undefined) {
    throw new Error(
      `dustcastle: no known API host for provider '${provider}'. Add it to PROVIDER_API_HOSTS (src/config/provider-hosts.ts).`,
    );
  }
  return hosts;
}

/**
 * The configured model's API host(s) for Agent Egress (ADR 0010), or `undefined`
 * when no model is set — no model means no agent runs, so a pure build stays
 * closed. Throws on an unknown provider (via {@link modelProviderHosts}). `dir`
 * injectable for tests.
 */
export function configuredAgentModelHosts(dir: string = DUSTCASTLE_HOME): readonly string[] | undefined {
  const selection = loadModelSelection(dir);
  if (selection === undefined) return undefined;
  return modelProviderHosts(selection.model);
}

/** Build the pi agent provider from a model selection. */
export function buildPiAgent(selection: ModelSelection): sandcastle.AgentProvider {
  const options: sandcastle.PiOptions = {
    ...(selection.thinking !== undefined ? { thinking: selection.thinking } : {}),
  };
  return sandcastle.pi(selection.model, options);
}

/** A bind mount of a host login dir into the sandbox (structurally a sandcastle MountConfig). */
export interface AgentAuthMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/**
 * The host pi login dir, mounted into the sandbox so the agent authenticates
 * **in-container** off the developer's existing `pi login` — exactly how
 * agentstack mounts it. Same path both sides; sandcastle tilde-expands to host
 * home / sandbox home. Read-write, since pi refreshes tokens and writes its
 * session log.
 */
export const PI_AUTH_MOUNT: AgentAuthMount = {
  hostPath: "~/.pi/agent",
  sandboxPath: "~/.pi/agent",
};

/** The sandbox mounts carrying the pi login inward. pi-only, so always the one mount. */
export function agentAuthMounts(): AgentAuthMount[] {
  return [PI_AUTH_MOUNT];
}

/**
 * Build the `SandcastleHandoff` from the global config, or `undefined` when there
 * is nothing to launch (no model, or a model but no task prompt — the sandbox is
 * still provisioned, there's just no agent run). Throws on a genuinely malformed
 * config. The task/prompt is optional and global too (never project-local): an
 * inline `prompt`, or a `promptFile` (absolute, or relative to `~/.dustcastle/`).
 */
export function loadHandoff(dir: string = DUSTCASTLE_HOME): SandcastleHandoff | undefined {
  const selection = loadModelSelection(dir);
  if (selection === undefined) return undefined;
  const raw = readGlobalConfig(dir)!;

  const hasPrompt = typeof raw.prompt === "string";
  const hasPromptFile = typeof raw.promptFile === "string";
  if (hasPrompt && hasPromptFile) {
    throw new Error('invalid ~/.dustcastle/config.json: set at most one of "prompt" / "promptFile"');
  }
  if (!hasPrompt && !hasPromptFile) return undefined; // model set, no task → nothing to launch

  const promptFile = hasPromptFile ? resolvePromptFile(raw.promptFile as string, dir) : undefined;
  const name = optionalString(raw.name, "name");
  const maxIterations = optionalPositiveInt(raw.maxIterations, "maxIterations");
  const promptArgs = parsePromptArgs(raw.promptArgs);
  const completionSignal = parseCompletionSignal(raw.completionSignal);
  const idleTimeoutSeconds = optionalPositiveInt(raw.idleTimeoutSeconds, "idleTimeoutSeconds");
  const hooks = parseHooks(raw.hooks);

  return {
    agent: buildPiAgent(selection),
    ...(hasPrompt ? { prompt: raw.prompt as string } : {}),
    ...(promptFile !== undefined ? { promptFile } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(promptArgs !== undefined ? { promptArgs } : {}),
    ...(completionSignal !== undefined ? { completionSignal } : {}),
    ...(idleTimeoutSeconds !== undefined ? { idleTimeoutSeconds } : {}),
    ...(hooks !== undefined ? { hooks } : {}),
  };
}

function parseThinking(value: unknown): PiThinking | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(PI_THINKING as readonly string[]).includes(value)) {
    throw fail(`"thinking" must be one of ${PI_THINKING.join(", ")}`);
  }
  return value as PiThinking;
}

function resolvePromptFile(promptFile: string, dir: string): string {
  return isAbsolute(promptFile) ? promptFile : resolve(dir, promptFile);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw fail(`"${field}" must be a string`);
  return value;
}

function optionalPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw fail(`"${field}" must be a positive integer`);
  }
  return value;
}

function parsePromptArgs(value: unknown): Record<string, string | number | boolean> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail('"promptArgs" must be an object of string/number/boolean values');
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      throw fail(`"promptArgs.${k}" must be a string, number, or boolean`);
    }
    out[k] = v;
  }
  return out;
}

function parseCompletionSignal(value: unknown): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  throw fail('"completionSignal" must be a string or an array of strings');
}

function parseHooks(value: unknown): SandcastleHandoff["hooks"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) throw fail('"hooks" must be an object');
  const onSandboxReady = (value as Record<string, unknown>).onSandboxReady;
  if (onSandboxReady === undefined) return undefined;
  if (!Array.isArray(onSandboxReady) || !onSandboxReady.every((c) => typeof c === "string")) {
    throw fail('"hooks.onSandboxReady" must be an array of command strings');
  }
  return {
    sandbox: { onSandboxReady: (onSandboxReady as string[]).map((command) => ({ command })) },
  };
}

function fail(detail: string): Error {
  return new Error(`invalid ~/.dustcastle/config.json: ${detail}`);
}
