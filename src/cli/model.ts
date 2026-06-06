import { loadModelSelection, writeModel } from "../config/global.js";
import { listPiModels, type PiModelOption } from "./pi-models.js";
import { singleSelect } from "./select.js";
import { processTerminal, type SelectIo, type Terminal } from "./terminal.js";

export type ModelLister = () => Map<string, PiModelOption[]>;
export type EnsureModelOutcome = "proceed" | "cancelled" | "no-model";
export type PickAndWriteModelOutcome = "saved" | "cancelled" | "no-models";

const NO_MODELS_MESSAGE =
  "dustcastle: no pi models found. Run `pi` then `/login` to authenticate, then re-run `dustcastle config`.\n";
const NO_CONFIGURED_MODEL_MESSAGE =
  "dustcastle: no model configured — run `dustcastle config`\n";

/**
 * Interactively choose a pi model (provider → model), mirroring agentstack's
 * picker. Returns the `provider/model` value, or `undefined` when there are no
 * models or the operator cancels.
 */
export async function chooseModel(
  byProvider: Map<string, PiModelOption[]>,
  io: SelectIo,
): Promise<string | undefined> {
  if (byProvider.size === 0) return undefined;

  const providers = [...byProvider.keys()];
  let models: PiModelOption[];
  if (providers.length === 1) {
    models = byProvider.get(providers[0]!)!;
  } else {
    const provider = await singleSelect(
      "Which provider?",
      providers.map((p) => ({ label: p, value: p })),
      io,
    );
    if (provider === undefined) return undefined;
    models = byProvider.get(provider)!;
  }
  return singleSelect("Which model?", models, io);
}

/**
 * Shared model-setting action: pick a pi model and persist it to the **global**
 * config — the one model every project / every instance uses (there is no
 * project-local config). The command surface decides how to map cancellation to
 * exit codes: `dustcastle run` treats first-run cancellation as an interrupt;
 * `dustcastle config` treats hub/action cancellation as exit-without-write.
 */
export async function pickAndWriteModel(
  term: Terminal = processTerminal(),
  listModels: ModelLister = listPiModels,
  dir?: string,
): Promise<PickAndWriteModelOutcome> {
  const byProvider = listModels();
  if (byProvider.size === 0) {
    term.error(NO_MODELS_MESSAGE);
    return "no-models";
  }

  const selected = await chooseModel(byProvider, term);
  if (selected === undefined) return "cancelled";

  writeModel(selected, dir === undefined ? undefined : { dir });
  term.error(
    `dustcastle: model set to ${selected} — saved to ~/.dustcastle/config.json (used by every project).\n`,
  );
  return "saved";
}

/**
 * Ensure a global model is configured, picking one interactively on first use
 * (the "first run / install picks a model" path). Returns whether the caller may
 * continue. Cancellation aborts cleanly; headless first-run misconfiguration
 * fails fast; interactive no-models preserves the existing ADR 0009 provisioning
 * flow.
 */
export async function ensureModel(
  term: Terminal = processTerminal(),
  listModels: ModelLister = listPiModels,
  dir?: string,
): Promise<EnsureModelOutcome> {
  const existing = loadModelSelection(dir);
  if (existing !== undefined) return "proceed";
  if (!term.isTTY) {
    term.error(NO_CONFIGURED_MODEL_MESSAGE);
    return "no-model";
  }

  const outcome = await pickAndWriteModel(term, listModels, dir);
  return outcome === "cancelled" ? "cancelled" : "proceed";
}
