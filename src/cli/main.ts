#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { configuredAgentModelHosts, loadModelSelection } from "../config/global.js";
import { detect } from "../detect/index.js";
import { parseImpurityMode } from "../impurity/index.js";
import { prepareRun } from "../run/index.js";
import { orchestrate } from "../run/orchestrate.js";
import { parseYesNo, pendingImpurityAsk, writeImpurityMarker } from "../run/impurity.js";
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

  // Interactive `ask` (ADR 0004): only a real TTY can answer. Resolve the policy
  // as if a human were present; if it lands on `ask`, prompt y/n and record the
  // consent marker on yes (which `prepareRun` then reads as cached consent). A
  // headless run skips this entirely — the decisive fallback handles it.
  if (process.stdin.isTTY) {
    const declined = await confirmImpurityIfAsked(cwd);
    if (declined) return 1;
  }

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
  const agentModelHosts = configuredAgentModelHosts();
  const prepared = prepareRun({
    cwd,
    onLine: (l) => process.stderr.write(`${l}\n`),
    ...(agentModelHosts !== undefined ? { agentModelHosts } : {}),
  });
  const { detection, provisioned, plan, impurity, pinned } = prepared;
  // Surface the network posture + reproducibility, never silently (ADR 0004/0005).
  // Distinguish Build Egress from Agent Egress (ADR 0010) so a pure build that opens
  // only the model host never reads as "the build went online."
  const egressLine =
    plan.egress.kind === "none"
      ? "closed (pure, no network)"
      : `allowlist — build: ${plan.egress.buildHosts.length > 0 ? `[${plan.egress.buildHosts.join(", ")}]` : "(offline)"}` +
        `  agent: ${plan.egress.agentHosts.length > 0 ? `[${plan.egress.agentHosts.join(", ")}]` : "(none)"}`;
  const purityLine =
    impurity.kind === "impure"
      ? "impure (marker written to .dustcastle/impure.json)"
      : "pure / reproducible";
  console.error(
    [
      `🏖️  dustcastle: provisioned ${detection.ecosystem}` +
        (detection.toolchainVersion ? ` ${detection.toolchainVersion}` : ""),
      `    store mode : ${provisioned.mode}  (rootless nix-portable)`,
      `    toolchain  : ${provisioned.toolchainStorePath}`,
      `    deps       : ${provisioned.depsStorePath || "(installed in container — impure)"}`,
      `    build      : ${purityLine}`,
      `    egress     : ${egressLine}`,
      ...(pinned ? [`    pinned     : generated ${pinned.lockfile} (commit it — pin-then-pure, pure offline)`] : []),
      `    /nix/store mounted read-only into the sandbox`,
    ].join("\n"),
  );

  // The agent model is required to launch the orchestration loop; without it the
  // Sandbox is still provisioned and ready (run `dustcastle model` to choose one).
  const selection = loadModelSelection();
  if (selection === undefined) {
    console.error("    (sandbox provisioned and ready; run `dustcastle model` to choose an agent model)");
    return 0;
  }
  console.error(`    agent      : pi @ ${selection.model}  (~/.pi/agent mounted)`);

  // Drive the built-in parallel-planner-with-review loop (plan → execute+review →
  // merge) over the repo's beads issues, on the Store-provisioned sandbox. The
  // orchestrator re-provisions internally against the now-warm Store (ADR 0002).
  await orchestrate({ cwd, onLine: (l) => process.stderr.write(`${l}\n`) });
  return 0;
}

/**
 * If an interactive `ask` is pending for this project, prompt the human y/n.
 * Returns `true` when the build was declined (caller should exit non-zero). On
 * "yes" the consent marker is written so the downstream `prepareRun` builds
 * impurely without re-asking. No-op when nothing is pending.
 */
async function confirmImpurityIfAsked(cwd: string): Promise<boolean> {
  const detection = detect(cwd)[0];
  if (detection === undefined) return false;
  const ask = pendingImpurityAsk({
    cwd,
    detection,
    mode: parseImpurityMode(process.env),
    env: process.env,
  });
  if (ask === undefined) return false;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(ask.prompt);
    if (!parseYesNo(answer)) {
      console.error("dustcastle: impure build declined — nothing provisioned.");
      return true;
    }
  } finally {
    rl.close();
  }
  writeImpurityMarker(cwd, ask.marker);
  return false;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`dustcastle: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
