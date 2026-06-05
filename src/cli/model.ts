import { loadModelSelection, writeModel } from "../config/global.js";
import { listPiModels, type PiModelOption } from "./pi-models.js";
import { singleSelect } from "./select.js";
import { processTerminal, type SelectIo, type Terminal } from "./terminal.js";

export type ModelLister = () => Map<string, PiModelOption[]>;
export type EnsureModelOutcome = "proceed" | "cancelled";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_INTERRUPT = 130;
const NO_MODELS_MESSAGE =
  "dustcastle: no pi models found. Run `pi` then `/login` to authenticate, then re-run `dustcastle model`.\n";

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
 * `dustcastle model`: pick a pi model and persist it to the **global** config —
 * the one model every project / every instance uses (there is no project-local
 * config). Returns a process exit code.
 */
export async function runModelCommand(
  term: Terminal = processTerminal(),
  listModels: ModelLister = listPiModels,
  dir?: string,
): Promise<number> {
  if (!term.isTTY) {
    term.error("dustcastle: `dustcastle model` needs an interactive terminal to pick a model.\n");
    return EXIT_FAILURE;
  }

  const byProvider = listModels();
  if (byProvider.size === 0) {
    term.error(NO_MODELS_MESSAGE);
    return EXIT_FAILURE;
  }

  const selected = await chooseModel(byProvider, term);
  if (selected === undefined) return EXIT_INTERRUPT;

  writeModel(selected, dir === undefined ? undefined : { dir });
  term.error(
    `dustcastle: model set to ${selected} — saved to ~/.dustcastle/config.json (used by every project).\n`,
  );
  return EXIT_SUCCESS;
}

/**
 * Ensure a global model is configured, picking one interactively on first use
 * (the "first run / install picks a model" path). Returns whether the caller may
 * continue. Cancellation aborts cleanly; other no-selection paths preserve the
 * existing ADR 0009 provisioning flow.
 */
export async function ensureModel(
  term: Terminal = processTerminal(),
  listModels: ModelLister = listPiModels,
  dir?: string,
): Promise<EnsureModelOutcome> {
  const existing = loadModelSelection(dir);
  if (existing !== undefined) return "proceed";
  if (!term.isTTY) return "proceed"; // headless no-model semantics are handled by dustcastle-8kv.2

  const code = await runModelCommand(term, listModels, dir);
  return code === EXIT_INTERRUPT ? "cancelled" : "proceed";
}
