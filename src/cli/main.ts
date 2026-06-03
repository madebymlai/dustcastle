#!/usr/bin/env node
import { configuredAgentModelHosts, DUSTCASTLE_HOME, loadModelSelection } from "../config/global.js";
import { createLogger } from "../log/pino.js";
import { logPosture, logSweep } from "./posture.js";
import { prepareRun } from "../run/index.js";
import { orchestrate } from "../run/orchestrate.js";
import { readLastSweepLine } from "../store/autogc.js";
import { join } from "node:path";
import { runAutoGcCommand } from "./autogc.js";
import { runGcCommand } from "./gc.js";
import { ensureModel, runModelCommand } from "./model.js";

const USAGE = `dustcastle — a global toolchain manager for AI coding agent sandboxes.

Usage:
  dustcastle run        Provision this project from the shared Nix Store, then run
                        the built-in orchestration loop over the repo's beads issues.
  dustcastle model      Choose the pi agent model (saved globally; every project
                        uses it). Run automatically the first time you 'run'.
  dustcastle gc         Sweep the shared Nix Store now (optimise + collect unrooted
                        paths). Active runs stay protected by their scoped roots.

  dustcastle run takes no arguments: it detects the ecosystem, realizes the
  Toolchain into the shared Store, provisions the Sandbox from it, and drives
  the plan → execute+review → merge loop (ADR 0002).`;

function createCliLogger() {
  return createLogger({ homeDir: DUSTCASTLE_HOME, env: process.env });
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? "run";
  if (command === "-h" || command === "--help" || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (command === "model") {
    return runModelCommand();
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
    return 2;
  }

  const cwd = process.cwd();

  // The agent model is a single global choice every project shares (no
  // project-local config). The first run with no model configured picks one
  // interactively — same as agentstack's install flow; `dustcastle model`
  // re-picks. Headless with no model just provisions and says so below.
  await ensureModel();

  const rootLogger = createCliLogger();

  // Never-silent reconciled with never-worry (ADR 0007): the auto-GC sweep is quiet
  // by default and the NEXT run surfaces the last "freed X" line here. Degrades
  // silently when no sweep has happened yet (no gc.log).
  const lastSweep = readLastSweepLine(join(DUSTCASTLE_HOME, "gc.log"));
  if (lastSweep !== undefined) logSweep(rootLogger, lastSweep);

  // dustcastle's half: detect → realize the Store → plan the Sandbox. Surface
  // the active runtime mode (ADR 0008 — never silent) and what was provisioned.
  // Resolve Agent Egress (ADR 0010) up front: the configured model's API host(s),
  // so an unknown provider throws here — before anything is provisioned. Undefined
  // ⇒ no model ⇒ no agent egress.
  const agentModelHosts = configuredAgentModelHosts();
  const selection = loadModelSelection();

  // No agent model: nothing runs in the Sandbox, so there's no egress to confine.
  // Provision the Store, print the posture, and stop — the user picks a model and
  // re-runs. (ADR 0010: agent egress only matters when an agent will actually run.)
  if (selection === undefined) {
    const prepared = prepareRun({
      cwd,
      logger: rootLogger.child({ mod: "store" }),
      ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
    });
    logPosture(rootLogger, prepared, {
      note: "(sandbox provisioned and ready; run `dustcastle model` to choose an agent model)",
    });
    return 0;
  }

  // A model is set: drive the parallel-planner-with-review loop (plan → execute+
  // review → merge) over the repo's beads issues. orchestrate provisions exactly
  // ONCE and stands the egress backend up BEFORE provisioning — so a host that
  // can't enforce scoped egress fails fast, before any build work. The posture
  // banner prints from inside that flow (onPrepared), never a pre-run provision.
  await orchestrate({
    cwd,
    logger: rootLogger.child({ mod: "orchestrate" }),
    ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
    onPrepared: (prepared) => {
      logPosture(rootLogger, prepared, {
        agent: { runner: "pi", model: selection.model, mount: "~/.pi/agent" },
      });
    },
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`dustcastle: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
