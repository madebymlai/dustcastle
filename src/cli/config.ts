import { EXIT_FAILURE, EXIT_SUCCESS } from "./exit-codes.js";
import { listPiModels } from "./pi-models.js";
import { singleSelect } from "./select.js";
import { processTerminal, type Terminal } from "./terminal.js";
import { pickAndWriteModel, type ModelLister } from "./model.js";

const CONFIG_ACTIONS = [
  { label: "Model — choose the pi agent model", value: "model" },
] as const;

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

  switch (action) {
    case "model": {
      const outcome = await pickAndWriteModel(term, listModels, dir);
      return outcome === "no-models" ? EXIT_FAILURE : EXIT_SUCCESS;
    }
    default:
      return EXIT_SUCCESS;
  }
}
