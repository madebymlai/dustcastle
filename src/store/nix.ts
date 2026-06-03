import { spawnSync } from "node:child_process";
import { ensureNixPortableSync } from "./index.js";
import { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

/**
 * The full nix-portable port: the runner contract + real runner, the `nix-store`
 * command vocabulary, and the report parsers + reports — kept together as one
 * learnable "how to talk to nix" surface. The individually-shallow arg-builders
 * stay beside the runner deliberately (a single nix surface over per-function depth).
 */

/** The minimal result of a nix invocation the orchestration reasons about. */
export interface NixResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `nix-portable <args>`. Injected in tests; defaults to a real nix-portable spawn. */
export type NixRunner = (args: readonly string[]) => NixResult;

/** A real nix-portable runner: same spawn shape as `runNixBuild` (NP_RUNTIME env). */
export function nixPortableRunner(): NixRunner {
  const nixPortable = ensureNixPortableSync();
  const mode: RuntimeMode = chooseRuntimeMode({ unprivilegedUserns: unprivilegedUsernsAvailable() });
  return (args: readonly string[]): NixResult => {
    const r = spawnSync(nixPortable, [...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NP_RUNTIME: mode },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

/** `nix-store --add-root <link> --realise <path>` — register an (indirect) GC root. */
export function addRootArgs(storePath: string, link: string): string[] {
  return ["nix-store", "--add-root", link, "--realise", storePath];
}

/** `nix-store --gc` — delete every unreachable (unrooted) store path. */
export function collectGarbageArgs(): string[] {
  return ["nix-store", "--gc"];
}

/** `nix-store --optimise` — reclaim space by hard-linking identical files. */
export function optimiseArgs(): string[] {
  return ["nix-store", "--optimise"];
}

/**
 * Non-destructive GC query (`nix-store --gc --print-{dead,live}`): list the paths a
 * sweep WOULD delete (`dead`) or keep (`live`) without deleting anything. The
 * dry-run the policy layer (and the gated e2e) uses to prove a scoped root protects
 * its closure without endangering the shared warm store.
 *
 * TOMBSTONE: no production consumer — test / gated-e2e only. Kept as part of the
 * nix surface so the command vocabulary is complete and learnable in one place.
 */
export function gcQueryArgs(which: "dead" | "live"): string[] {
  return ["nix-store", "--gc", `--print-${which}`];
}

/** What a GC sweep collected — surfaced, never silent (ADR 0007). */
export interface GcReport {
  readonly pathsDeleted: number;
  readonly bytesFreed: number;
}

/** What an optimise pass reclaimed by hard-linking. */
export interface OptimiseReport {
  readonly bytesFreed: number;
  readonly filesLinked: number;
}

/** Parse `nix-store --gc` output: a `deleting "…"` line per path + a `N bytes freed` total. */
export function parseGcReport(output: string): GcReport {
  const pathsDeleted = (output.match(/^deleting /gm) ?? []).length;
  const bytesFreed = Number(output.match(/(\d+)\s+bytes freed/)?.[1] ?? 0);
  return { pathsDeleted, bytesFreed };
}

/** Parse `nix-store --optimise` output: `N bytes (… MiB) freed by hard-linking M files`. */
export function parseOptimiseReport(output: string): OptimiseReport {
  const match = output.match(/(\d+)\s+bytes.*?freed by hard-linking\s+(\d+)\s+files/s);
  return { bytesFreed: Number(match?.[1] ?? 0), filesLinked: Number(match?.[2] ?? 0) };
}
