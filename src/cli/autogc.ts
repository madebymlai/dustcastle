import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DUSTCASTLE_HOME } from "../config/global.js";
import { autoGc, type AutoGcOptions } from "../store/autogc.js";
import { diskSpace, measureStoreBytes } from "../store/ceiling.js";
import { defaultRecencyRootsDir, nixPortableRunner } from "../store/gc.js";

/**
 * The hidden `dustcastle __autogc` child entry (ADR 0007) — the detached one-shot
 * `run()` spawns after every run. It builds the REAL wiring (a nix-portable runner,
 * nix store-size accounting, statfs free/total, the dustcastle home + recency-root
 * dir, the wall clock) and hands it to the pure `autoGc` brain. It is best-effort
 * to the bone: it always returns 0 and never throws, so a failed sweep is invisible
 * to everything. Deps are injectable so the command is unit-testable without nix.
 */
export async function runAutoGcCommand(
  opts: Partial<AutoGcOptions> & { readonly onLine?: (line: string) => void } = {},
): Promise<number> {
  const log = opts.onLine ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    const run = opts.run ?? nixPortableRunner();
    autoGc({
      run,
      measure: opts.measure ?? (() => measureStoreBytes(run)),
      disk: opts.disk ?? (() => diskSpace(diskProbePath())),
      dir: opts.dir ?? DUSTCASTLE_HOME,
      recencyRootsDir: opts.recencyRootsDir ?? defaultRecencyRootsDir(),
      now: opts.now ?? (() => Date.now()),
      onLine: log,
      ...(opts.lockPath !== undefined ? { lockPath: opts.lockPath } : {}),
      ...(opts.gcLogPath !== undefined ? { gcLogPath: opts.gcLogPath } : {}),
    });
  } catch (e) {
    // The child must never fail loudly — it is invisible maintenance.
    log(`gc: WARNING autogc child error (ignored): ${(e as Error).message}`);
  }
  return 0;
}

/**
 * An existing path on the Store's filesystem, for the statfs free/total reading.
 * The rootless store lives under `~/.nix-portable`; statfs of any path on that
 * filesystem yields the same free/total, so the home dir (always present) is a safe
 * probe — `NP_LOCATION` redirects the store but stays on the same volume in the
 * common case.
 */
function diskProbePath(): string {
  return homedir();
}

export interface SpawnAutoGcOptions {
  /** The CLI entrypoint to re-invoke (defaults to the script that launched this process). */
  readonly cliEntry?: string;
  /** Inject the spawn function (tests); defaults to `node:child_process.spawn`. */
  readonly spawnFn?: typeof spawn;
  /** Surface a warning if the spawn can't be set up (best-effort). */
  readonly onLine?: (line: string) => void;
}

/**
 * Spawn the detached `__autogc` one-shot (ADR 0007) — a true background child that
 * `unref()`s so the parent run exits immediately, GC entirely off the hot path. It
 * is NOT a daemon: it measures, sweeps, logs, and exits (ADR 0008). Best-effort: if
 * the CLI entry can't be located or the spawn fails, it is silently skipped — a
 * missing sweep never breaks a run.
 */
export function spawnAutoGc(opts: SpawnAutoGcOptions = {}): void {
  const cliEntry = opts.cliEntry ?? process.argv[1];
  if (cliEntry === undefined || cliEntry === "") return; // can't locate the CLI → skip
  try {
    const child = (opts.spawnFn ?? spawn)(process.execPath, [cliEntry, "__autogc"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (e) {
    opts.onLine?.(`gc: WARNING could not spawn autogc child: ${(e as Error).message}`);
  }
}
