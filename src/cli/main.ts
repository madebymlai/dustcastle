#!/usr/bin/env node
import { DUSTCASTLE_HOME, loadModelSelection, type ModelSelection } from "../config/global.js";
import { createLogger } from "../log/pino.js";
import { logHostPosture, logPosture, logSweep } from "./posture.js";
import { EXIT_FAILURE, EXIT_INTERRUPT, EXIT_SUCCESS, EXIT_USAGE } from "./exit-codes.js";
import { orchestrate, type OrchestrateOptions } from "../run/orchestrate.js";
import { parseRunArgs } from "./parseRunArgs.js";
import { readLastSweepLine } from "../store/autogc.js";
import { join } from "node:path";
import { runAutoGcCommand } from "./autogc.js";
import { runConfigHub } from "./config.js";
import { runGcCommand } from "./gc.js";
import { ensureModel, NO_CONFIGURED_MODEL_MESSAGE, type EnsureModelOutcome } from "./model.js";
import { processTerminal, type Terminal } from "./terminal.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const USAGE = `dustcastle — a global toolchain manager for AI coding agent sandboxes.

Usage:
  dustcastle run        Provision this project from the shared Nix Store, then run
                        the built-in orchestration loop over the repo's beads issues.
  dustcastle config     Open the global config hub (pi agent model picker and
                        curated sandbox Credentials such as GitHub).
  dustcastle gc         Sweep the shared Nix Store now (optimise + collect unrooted
                        paths). Active runs stay protected by their scoped roots.`;

function createCliLogger() {
  return createLogger({ homeDir: DUSTCASTLE_HOME, env: process.env });
}

export interface CliDeps {
  readonly terminal?: () => Terminal;
  readonly runConfig?: (term: Terminal) => Promise<number>;
  readonly ensureModel?: (term: Terminal) => Promise<EnsureModelOutcome>;
  readonly loadModelSelection?: () => ModelSelection | undefined;
  readonly orchestrate?: (opts: OrchestrateOptions) => Promise<void>;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const command = argv[0] ?? "run";
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return EXIT_SUCCESS;
  }
  const terminal = deps.terminal ?? processTerminal;
  if (command === "config") {
    return (deps.runConfig ?? ((term) => runConfigHub(term)))(terminal());
  }
  if (command === "gc") {
    return runGcCommand({ logger: createCliLogger().child({ mod: "gc" }) });
  }
  if (command === "__autogc") {
    // Hidden internal entry: the detached one-shot `run()` spawns after every run
    // (ADR 0007). Not in USAGE — it is invisible maintenance, never user-invoked.
    return runAutoGcCommand({ logger: createCliLogger().child({ mod: "gc" }) });
  }
  if (command !== "run") {
    console.error(`dustcastle: unknown command '${command}'.\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const cwd = process.cwd();

  // The agent model is a single global choice every project shares (no
  // project-local config). The first run with no model configured picks one
  // interactively — same as agentstack's install flow; `dustcastle config`
  // re-picks. Headless with no model fails fast before provisioning.
  const modelOutcome = await (deps.ensureModel ?? ensureModel)(terminal());
  switch (modelOutcome) {
    case "proceed":
      break;
    case "cancelled":
      return EXIT_INTERRUPT;
    case "no-model":
      return EXIT_FAILURE;
  }

  const rootLogger = createCliLogger();

  // Never-silent reconciled with never-worry (ADR 0007): the auto-GC sweep is quiet
  // by default and the NEXT run surfaces the last "freed X" line here. Degrades
  // silently when no sweep has happened yet (no gc.log).
  const lastSweep = readLastSweepLine(join(DUSTCASTLE_HOME, "gc.log"));
  if (lastSweep !== undefined) logSweep(rootLogger, lastSweep);

  // Load the global model selection — set by the first run or `dustcastle config`.
  const selection = (deps.loadModelSelection ?? loadModelSelection)();

  // No agent model: nothing can run. Print the config hint and exit without
  // provisioning anything (no Store, no GC roots, no deps-cache entries).
  // Unified across all modes (ADR 0017).
  if (selection === undefined) {
    console.error(NO_CONFIGURED_MODEL_MESSAGE);
    return EXIT_FAILURE;
  }

  // A model is set: drive the parallel-planner-with-review loop (plan → execute+
  // review → merge) over the repo's beads issues. orchestrate provisions exactly
  // ONCE. The posture banner prints from inside that flow (onPrepared), never a
  // pre-run provision.
  //
  // Parse the dustless flag from argv[1:] (argv[0] is the "run" command).
  const { dustless } = parseRunArgs(argv.slice(1));

  // Dustless run: surface host posture ahead of the loop (ADR 0014).
  if (dustless) {
    logHostPosture(rootLogger, { runner: "pi", model: selection.model, mount: "~/.pi/agent" });
  }

  const runOrchestrate = deps.orchestrate ?? orchestrate;
  await runOrchestrate({
    cwd,
    dustless,
    logger: rootLogger.child({ mod: "orchestrate" }),
    onPrepared: (prepared) => {
      logPosture(rootLogger, prepared, {
        agent: { runner: "pi", model: selection.model, mount: "~/.pi/agent" },
      });
    },
  });
  return EXIT_SUCCESS;
}

function isDirectCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  // npm installs the bin as a SYMLINK (…/bin/dustcastle -> …/dist/cli/main.js), so
  // argv[1] is the symlink path while import.meta.url is the resolved real file —
  // they never match and the CLI silently no-ops when invoked by name. Resolve the
  // symlink before comparing.
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectCli()) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`dustcastle: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(EXIT_FAILURE);
    },
  );
}
