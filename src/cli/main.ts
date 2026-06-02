#!/usr/bin/env node
import { configuredAgentModelHosts, loadModelSelection } from "../config/global.js";
import { prepareRun, type PreparedRun } from "../run/index.js";
import { orchestrate } from "../run/orchestrate.js";
import { DUSTCASTLE_HOME } from "../config/global.js";
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
  toolchain + deps into the shared Store, provisions the Sandbox from it, and
  drives the plan → execute+review → merge loop (ADR 0002).`;

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
    return runGcCommand();
  }
  if (command === "__autogc") {
    // Hidden internal entry: the detached one-shot `run()` spawns after every run
    // (ADR 0007). Not in USAGE — it is invisible maintenance, never user-invoked.
    return runAutoGcCommand();
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

  // Never-silent reconciled with never-worry (ADR 0007): the auto-GC sweep is quiet
  // by default and the NEXT run surfaces the last "freed X" line here. Degrades
  // silently when no sweep has happened yet (no gc.log).
  const lastSweep = readLastSweepLine(join(DUSTCASTLE_HOME, "gc.log"));
  if (lastSweep !== undefined) console.error(`🧹 dustcastle: ${lastSweep}`);

  // dustcastle's half: detect → realize the Store → plan the Sandbox. Surface
  // the active runtime mode (ADR 0008 — never silent) and what was provisioned.
  // Resolve Agent Egress (ADR 0010) so the printed posture matches the run's: the
  // agent's model host carves a route out of even a pure build. Throws actionably
  // on an unknown provider (caught at the top), before anything is provisioned.
  // Resolve Agent Egress (ADR 0010) up front: the configured model's API host(s),
  // so an unknown provider throws here — before anything is provisioned. Undefined
  // ⇒ no model ⇒ no agent egress.
  const agentModelHosts = configuredAgentModelHosts();
  const selection = loadModelSelection();
  const onLine = (l: string) => process.stderr.write(`${l}\n`);

  // No agent model: nothing runs in the Sandbox, so there's no egress to confine.
  // Provision the Store, print the posture, and stop — the user picks a model and
  // re-runs. (ADR 0010: agent egress only matters when an agent will actually run.)
  if (selection === undefined) {
    const prepared = prepareRun({ cwd, onLine, ...(agentModelHosts !== undefined ? { agentModelHosts } : {}) });
    printPosture(prepared);
    console.error("    (sandbox provisioned and ready; run `dustcastle model` to choose an agent model)");
    return 0;
  }

  // A model is set: drive the parallel-planner-with-review loop (plan → execute+
  // review → merge) over the repo's beads issues. orchestrate provisions exactly
  // ONCE and stands the egress backend up BEFORE provisioning — so a host that
  // can't enforce scoped egress fails fast, before any build work. The posture
  // banner prints from inside that flow (onPrepared), never a pre-run provision.
  await orchestrate({
    cwd,
    onLine,
    ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
    onPrepared: (prepared) => {
      printPosture(prepared);
      console.error(`    agent      : pi @ ${selection.model}  (~/.pi/agent mounted)`);
    },
  });
  return 0;
}

/**
 * Print the provisioned posture — runtime mode, every detected Ecosystem's
 * Toolchain, and the standing egress (distinguishing Build vs Agent Egress, ADR
 * 0010). Deps always install in-Sandbox (ADR 0012). Never silent (ADR 0005/0008).
 */
function printPosture(prepared: PreparedRun): void {
  const { plan, ecosystems } = prepared;
  const egressLine =
    plan.egress.kind === "none"
      ? "closed (no network)"
      : `allowlist — build: ${plan.egress.buildHosts.length > 0 ? `[${plan.egress.buildHosts.join(", ")}]` : "(offline)"}` +
        `  agent: ${plan.egress.agentHosts.length > 0 ? `[${plan.egress.agentHosts.join(", ")}]` : "(none)"}`;
  const provisioned = ecosystems.map(
    (e) =>
      `    ${e.detection.ecosystem.padEnd(7)}: ${e.detection.toolchainVersion ?? "(default)"}  ${e.provisioned.toolchainStorePath}`,
  );
  console.error(
    [
      `🏖️  dustcastle: provisioned ${ecosystems.map((e) => e.detection.ecosystem).join(" + ")}`,
      `    store mode : ${prepared.provisioned.mode}  (rootless nix-portable)`,
      ...provisioned,
      `    deps       : installed in-Sandbox (ADR 0012)`,
      `    egress     : ${egressLine}`,
      `    /nix/store mounted read-only into the sandbox`,
    ].join("\n"),
  );
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`dustcastle: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
