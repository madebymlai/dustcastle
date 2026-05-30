import { collectGarbage, type NixRunner } from "../store/gc.js";

/**
 * `dustcastle gc`: the manual, user-invoked store sweep (ADR 0007). Runs
 * `nix store optimise` (file-level dedup) then `nix-store --gc` (delete unrooted
 * paths), surfacing what it freed — never silent. No threshold and no recency tail
 * here: the user asked explicitly, so it always sweeps; an in-flight `dustcastle
 * run` stays safe because its closure is pinned by live scoped roots for the
 * duration of the run (released only on completion). The automatic, policy-driven
 * trigger (disk ceiling + recency tail) is a separate, gated path.
 *
 * The nix runner is injectable for tests; production uses a real nix-portable spawn.
 * Returns a process exit code.
 */
export async function runGcCommand(opts: {
  readonly run?: NixRunner;
  readonly onLine?: (line: string) => void;
} = {}): Promise<number> {
  const log = opts.onLine ?? ((l: string) => process.stderr.write(`${l}\n`));
  log("dustcastle: sweeping the shared Nix Store (optimise → collect-garbage)…");

  const report = collectGarbage({
    optimise: true,
    ...(opts.run !== undefined ? { run: opts.run } : {}),
    onLine: log,
  });

  const freed = report.gc.bytesFreed + (report.optimise?.bytesFreed ?? 0);
  log(
    `dustcastle: gc done — collected ${report.gc.pathsDeleted} unrooted path(s)` +
      (report.optimise ? `, hard-linked ${report.optimise.filesLinked} file(s)` : "") +
      `, freed ${freed} bytes total.`,
  );
  return 0;
}
