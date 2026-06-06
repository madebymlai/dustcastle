import { CREDENTIALS, credentialDescriptor, type Credential } from "../credentials/index.js";
import { writeCredentialValue } from "../config/global.js";
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
  { label: "Credentials — configure sandbox credentials", value: "credentials" },
] as const;

const CREDENTIAL_OPTIONS: ReadonlyArray<{ readonly label: string; readonly value: Credential }> = CREDENTIALS.map(
  (credential) => ({
    label: `${credential.label} — ${credential.envName}`,
    value: credential.credential,
  }),
);

const KEY_ENTER = "\r";
const KEY_NEWLINE = "\n";
const KEY_CTRL_C = "\x03";
const KEY_BACKSPACE = "\b";
const KEY_DELETE = "\x7f";

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
    case "credentials":
      return credentialsOutcomeExitCode(await pickAndWriteCredential(term, dir));
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

type PickAndWriteCredentialOutcome = "saved" | "cancelled";

async function pickAndWriteCredential(
  term: Terminal,
  dir: string | undefined,
): Promise<PickAndWriteCredentialOutcome> {
  const selected = await singleSelect("Which credential?", CREDENTIAL_OPTIONS, term);
  if (selected === undefined) return "cancelled";

  const descriptor = credentialDescriptor(selected);
  const value = await promptHiddenLine(`Enter ${descriptor.envName}: `, term);
  if (value === undefined) return "cancelled";
  const writeOpts = dir === undefined ? {} : { dir };
  writeCredentialValue(descriptor.envName, value, writeOpts);
  term.error(`credential ${descriptor.envName} saved\n`);
  return "saved";
}

function credentialsOutcomeExitCode(outcome: PickAndWriteCredentialOutcome): number {
  switch (outcome) {
    case "saved":
    case "cancelled":
      return EXIT_SUCCESS;
  }
  return assertNever(outcome);
}

function promptHiddenLine(prompt: string, term: Terminal): Promise<string | undefined> {
  term.write(`\n${prompt}`);
  return new Promise((resolve) => {
    let value = "";
    let dispose = (): void => undefined;
    const finish = (outcome: string | undefined): void => {
      dispose();
      term.write("\n");
      resolve(outcome);
    };
    dispose = term.onKey((chunk) => {
      for (const key of chunk) {
        if (key === KEY_CTRL_C) {
          finish(undefined);
          return;
        }
        if (key === KEY_ENTER || key === KEY_NEWLINE) {
          finish(value);
          return;
        }
        if (key === KEY_DELETE || key === KEY_BACKSPACE) {
          value = value.slice(0, -1);
          continue;
        }
        value += key;
      }
    });
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled config value: ${String(value)}`);
}
