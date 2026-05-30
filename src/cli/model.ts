import { loadModelSelection, writeModel } from "../config/global.js";
import { listPiModels, type PiModelOption } from "./pi-models.js";
import { singleSelect } from "./select.js";

/**
 * Interactively choose a pi model (provider → model), mirroring agentstack's
 * picker. Returns the `provider/model` value, or `undefined` when pi reports no
 * models (not installed, or not authenticated yet).
 */
export async function chooseModel(): Promise<string | undefined> {
  const byProvider = listPiModels();
  if (byProvider.size === 0) return undefined;

  const providers = [...byProvider.keys()];
  let models: PiModelOption[];
  if (providers.length === 1) {
    models = byProvider.get(providers[0]!)!;
  } else {
    const provider = await singleSelect(
      "Which provider?",
      providers.map((p) => ({ label: p, value: p })),
    );
    models = byProvider.get(provider)!;
  }
  return singleSelect("Which model?", models);
}

/**
 * `dustcastle model`: pick a pi model and persist it to the **global** config —
 * the one model every project / every instance uses (there is no project-local
 * config). Returns a process exit code.
 */
export async function runModelCommand(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("dustcastle: `dustcastle model` needs an interactive terminal to pick a model.");
    return 1;
  }
  const selected = await chooseModel();
  if (selected === undefined) {
    console.error(
      "dustcastle: no pi models found. Run `pi` then `/login` to authenticate, then re-run `dustcastle model`.",
    );
    return 1;
  }
  writeModel(selected);
  console.error(
    `dustcastle: model set to ${selected} — saved to ~/.dustcastle/config.json (used by every project).`,
  );
  return 0;
}

/**
 * Ensure a global model is configured, picking one interactively on first use
 * (the "first run / install picks a model" path). Returns the selection, or
 * `undefined` when none could be chosen (headless with no model, or pi unavailable).
 */
export async function ensureModel(): Promise<string | undefined> {
  const existing = loadModelSelection();
  if (existing !== undefined) return existing.model;
  if (!process.stdin.isTTY) return undefined; // headless: never block on a picker
  const code = await runModelCommand();
  if (code !== 0) return undefined;
  return loadModelSelection()?.model;
}
