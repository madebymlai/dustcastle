import { EXIT_FAILURE, EXIT_SUCCESS } from "./exit-codes.js";
import { listPiModels } from "./pi-models.js";
import { singleSelect } from "./select.js";
import { processTerminal, type Terminal } from "./terminal.js";
import {
  pickAndWriteModel,
  type ModelLister,
  type PickAndWriteModelOutcome,
} from "./model.js";

const CONFIG_ACTIONS = [
  { label: "Model — choose the pi agent model", value: "model" },
] as const;

type ConfigAction = (typeof CONFIG_ACTIONS)[number]["value"];

/**
 * `dustcastle config`: a global config hub over editable per-user settings.
 *
 * Cancellation is local to the hub: cancelling the menu or a nested action exits
 * successfully without writing, unlike `dustcastle run`'s first-run picker where
 * Ctrl-C still aborts the run with exit 130.
 */
export async function runConfigHub(
  term: Terminal = processTerminal(),
  listModels: ModelLister = listPiModels,
  dir?: string,
): Promise<number> {
  if (!term.isTTY) {
    term.error("dustcastle: `dustcastle config` needs an interactive terminal to edit config.\n");
    return EXIT_FAILURE;
  }

  const action = await singleSelect("Dustcastle config", CONFIG_ACTIONS, term);
  if (action === undefined) return EXIT_SUCCESS;

  return runConfigAction(action, term, listModels, dir);
}

async function runConfigAction(
  action: ConfigAction,
  term: Terminal,
  listModels: ModelLister,
  dir: string | undefined,
): Promise<number> {
  switch (action) {
    case "model":
      return modelOutcomeExitCode(await pickAndWriteModel(term, listModels, dir));
  }
  return assertNever(action);
}

function modelOutcomeExitCode(outcome: PickAndWriteModelOutcome): number {
  switch (outcome) {
    case "saved":
    case "cancelled":
      return EXIT_SUCCESS;
    case "no-models":
      return EXIT_FAILURE;
  }
  return assertNever(outcome);
}

function assertNever(value: never): never {
  throw new Error(`unhandled config value: ${String(value)}`);
}
