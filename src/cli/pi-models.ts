import { spawnSync } from "node:child_process";

/** A pickable pi model: a human label and the `provider/model` value pi expects. */
export interface PiModelOption {
  readonly label: string;
  readonly value: string;
}

/**
 * Parse `pi --list-models` output into provider → model options, mirroring
 * agentstack's picker. The output is a whitespace-columned table whose first row
 * is a header (`provider model context …`); the model name has no spaces, so it's
 * always column 1. The option value is `provider/model` (what `sandcastle.pi()`
 * takes); the label shows the model and its context window.
 */
export function parsePiModels(output: string): Map<string, PiModelOption[]> {
  const byProvider = new Map<string, PiModelOption[]>();
  const lines = output.trim().split("\n").slice(1); // drop the header row
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const [provider, model, context] = cols;
    if (provider === undefined || model === undefined) continue;
    const options = byProvider.get(provider) ?? [];
    options.push({
      label: context ? `${model} (${context})` : model,
      value: `${provider}/${model}`,
    });
    byProvider.set(provider, options);
  }
  return byProvider;
}

/**
 * Run `pi --list-models` and parse it. pi prints the model table to **stderr**
 * (agentstack merges it via `2>&1`), so we capture both streams. Returns an empty
 * map on any failure (pi not installed, or not yet authenticated) so the caller
 * can print an actionable "run `pi` then `/login`" hint instead of crashing.
 */
export function listPiModels(): Map<string, PiModelOption[]> {
  const res = spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: 15_000 });
  if (res.error !== undefined) return new Map();
  return parsePiModels(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
}
