import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Detection } from "../detect/index.js";
import { noopLogger, type Logger } from "../log/index.js";
import { CARGO_HOME_BASENAME } from "../ecosystems/rust.js";
import { packageManagerDescriptor, type PackageManagerDescriptor } from "../ecosystems/index.js";
import { runStreamingAsync, type StreamingLogLevel, type StreamingRunResult } from "../process/streaming.js";
import { parseStorePath } from "./parse.js";
import { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

export { physPath } from "./paths.js";
export { parseStorePath, storeHashOf } from "./parse.js";
export { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

export interface ProvisionSpec {
  /** The project directory to provision (its source is staged into the build). */
  readonly projectDir: string;
  /** What detection concluded (ADR 0006) — selects the Toolchain expression. */
  readonly detection: Detection;
  /** Path to the nix-portable binary (defaults to the dustcastle-owned copy). */
  readonly nixPortable?: string;
  /** Physical rootless store root (defaults to ~/.nix-portable/nix/store). */
  readonly physStoreRoot?: string;
  /** Structured build progress logs. */
  readonly logger?: Logger;
}

/** The realized Toolchain Store path for a project (ADR 0001/0008/0012). */
export interface Provisioned {
  /** The active rootless runtime, surfaced — never silent (ADR 0008). */
  readonly mode: RuntimeMode;
  /** Physical store root on the host (for staging into the Sandbox). */
  readonly physStoreRoot: string;
  /** Canonical /nix/store path of the language Toolchain. */
  readonly toolchainStorePath: string;
}

/**
 * Realize a project's Toolchain into the rootless Store (ADR 0008/0012). The Store
 * provision realizes ONLY the Toolchain — Project Deps install in-Sandbox via the
 * sandcastle hook (ADR 0012, always-impure), so there is no deps FOD to build here.
 * Returns the canonical Toolchain store path plus the physical root and runtime mode.
 */
export async function provisionStore(spec: ProvisionSpec): Promise<Provisioned> {
  const physStoreRoot = spec.physStoreRoot ?? join(homedir(), ".nix-portable", "nix", "store");
  const nixPortable = spec.nixPortable ?? ensureNixPortable();
  const mode = chooseRuntimeMode({ unprivilegedUserns: unprivilegedUsernsAvailable() });
  const pname = sanitizePname(basename(spec.projectDir));

  const buildDir = mkdtempSync(join(tmpdir(), "dustcastle-build-"));
  stageSource(spec.projectDir, join(buildDir, "src"));

  const logger = spec.logger ?? noopLogger;
  const run = (args: string[]) => runNixBuild(nixPortable, mode, [buildDir, ...args], logger);
  const ctx: BuildContext = { buildDir, pname, mode, physStoreRoot, run, logger };

  // Route by the Package Manager descriptor in the Ecosystem Registry (ADR 0001:
  // internal curation, NOT a plugin system; ADR 0006: the lockfile names the
  // manager, the manager carries the Toolchain expression). `detection.packageManager`
  // is the closed `PackageManager` union narrowed once at detection, and the Registry
  // is exhaustive over it by construction (architecture review candidate 2), so the
  // store's old defensive `default:`/Registry-miss guard has retired — the lookup's
  // own honest throw is the single never-drop-a-gate net (ADR 0004) if a caller
  // ever widens the type.
  const descriptor = packageManagerDescriptor(spec.detection.packageManager);

  // No provision gate any more (ADR 0012): every manager — bun included — provisions
  // its Toolchain into the Store and installs its Project Deps impurely in-Sandbox,
  // so there is no gated state to honour here.
  return provision(spec, ctx, descriptor);
}

/** Shared per-provision state passed to the generic provisioner. */
interface BuildContext {
  readonly buildDir: string;
  readonly pname: string;
  readonly mode: RuntimeMode;
  readonly physStoreRoot: string;
  readonly run: (args: string[]) => Promise<StreamingRunResult>;
  readonly logger: Logger;
}

/**
 * Provision one project's Toolchain from its Package Manager descriptor (ADR 0012,
 * always-impure). The descriptor's `generateToolchain` emits a Toolchain-ONLY Nix
 * expression (no deps FOD — Project Deps install in-Sandbox via the sandcastle hook),
 * and the store realizes its single Toolchain attr.
 */
async function provision(
  spec: ProvisionSpec,
  ctx: BuildContext,
  descriptor: PackageManagerDescriptor,
): Promise<Provisioned> {
  const build = descriptor.generateToolchain({
    pname: ctx.pname,
    // Thread the detected manager (ADR 0012) so Python's Toolchain ships the manager's
    // in-Sandbox export tool (uv/poetry); other ecosystems ignore it.
    packageManager: spec.detection.packageManager,
    // Thread the resolved Toolchain version (ADR 0006b) so the Toolchain build uses
    // the requested interpreter (Python; laimk-hse.3). Node/Go/Rust ignore it.
    ...(spec.detection.toolchainVersion !== undefined
      ? { toolchainVersion: spec.detection.toolchainVersion }
      : {}),
  });
  writeFileSync(join(ctx.buildDir, "default.nix"), build.expression);

  const toolchain = await ctx.run(["-A", build.attr, "--no-out-link"]);
  if (toolchain.status !== 0) {
    ctx.logger.error(
      { status: toolchain.status, stderr: toolchain.stderr.slice(-2000) },
      "toolchain build failed",
    );
    throw new Error(`store: toolchain build failed (exit ${toolchain.status}):\n${toolchain.stderr.slice(-2000)}`);
  }
  const toolchainStorePath = parseStorePath(toolchain.stdout);
  ctx.logger.debug({ storePath: toolchainStorePath }, "toolchain built");
  return {
    mode: ctx.mode,
    physStoreRoot: ctx.physStoreRoot,
    toolchainStorePath,
  };
}

// Rebuild artifacts that never belong in the Toolchain build input even if a project
// commits them: VCS metadata, nix build outputs, and per-ecosystem dependency/cache
// dirs rebuilt from the lockfile in-Sandbox (node's `node_modules`/Go's `vendor`,
// Python's `.venv` + dev caches — often hundreds of MB). The committed tree already
// excludes untracked junk; this is the "rebuilt, so excluded from the Nix input" set,
// pruned from the checkout so a project that mistakenly *tracks* node_modules can't
// bloat the staged build input.
const STAGE_SKIP: ReadonlySet<string> = new Set([
  ".git",
  "vendor",
  CARGO_HOME_BASENAME,
  "result",
  "node_modules",
  ".venv",
  ".tox",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
]);

/** Whether a single path segment should remain in the staged source. */
export function isStageableSource(path: string): boolean {
  const name = basename(path);
  return !STAGE_SKIP.has(name) && !name.startsWith("result-");
}

/**
 * Stage the project's COMMITTED source into the build dir so Store provisioning reads
 * a deterministic project snapshot — reproducible from commits, never the dirty
 * working tree. Materializes the committed tree with `git archive HEAD` (the same
 * checkout model as sandcastle's `git worktree add`), then drops rebuild artifacts
 * the commit may carry.
 *
 * Tracked-only by design, mirroring sandcastle: untracked / gitignored files (.beads
 * DBs, scratch, build logs) are simply not in the committed tree, so they can never
 * churn the Nix build input — and the few untracked paths an agent genuinely needs are
 * opted in elsewhere by name via `copyToWorktree`/`worktreeCopies`, never staged
 * wholesale here. Reading committed blobs instead of the work tree also makes
 * index/work-tree skew — a tracked file deleted from disk without staging the
 * deletion — structurally harmless: there is no disk read left to ENOENT on (the old
 * `.beads/.beads/.gitignore` crash). The tradeoff is sandcastle's exact contract:
 * uncommitted edits to tracked files are not built until committed.
 *
 * There is no working-dir fallback: when nothing is committed (not a git work tree,
 * or a repo with no commit yet) staging fails with an actionable "commit first"
 * error rather than silently building the dirty working tree — that would smuggle
 * untracked files back in, the exact thing the committed-tree model removes.
 */
export function stageSource(projectDir: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  archiveCommittedTree(projectDir, dest);
  // Drop tracked rebuild artifacts (node_modules / vendor / __pycache__ / …) that the
  // committed tree may carry — applied on TOP of the checkout, same intent as before.
  pruneRebuildArtifacts(dest);
}

/**
 * Materialize the committed tree at HEAD into `dest` via `git archive` piped through
 * `tar` (a temp tarball keeps huge trees off the heap; symlinks — even dangling ones
 * — survive as the link entries git stored). Throws an actionable "commit first"
 * error when there is no committed tree to read (not a git work tree, git
 * unavailable, or no commit yet) — dustcastle builds the committed source, so an
 * empty/uncommitted project is a user error to surface, not to paper over.
 */
function archiveCommittedTree(projectDir: string, dest: string): void {
  const tarDir = mkdtempSync(join(tmpdir(), "dustcastle-archive-"));
  const tarPath = join(tarDir, "src.tar");
  try {
    const archive = spawnSync(
      "git",
      ["-C", projectDir, "archive", "--format=tar", "-o", tarPath, "HEAD"],
      { encoding: "utf8" },
    );
    if (archive.status !== 0) {
      throw new Error(
        "store: nothing committed to stage — dustcastle builds the project's committed source. " +
          "Run `git init` if needed, then `git add -A && git commit` before provisioning." +
          (archive.stderr.trim() ? `\n(git archive HEAD: ${archive.stderr.trim()})` : ""),
      );
    }
    const extract = spawnSync("tar", ["-xf", tarPath, "-C", dest], { encoding: "utf8" });
    if (extract.status !== 0) {
      throw new Error(`store: failed to extract committed tree:\n${extract.stderr}`);
    }
  } finally {
    rmSync(tarDir, { recursive: true, force: true });
  }
}

/**
 * Recursively delete rebuild artifacts from the staged tree by basename — the
 * `isStageableSource` set (node_modules, vendor, result*, Python caches), at any
 * depth. Drops a whole tracked `node_modules` so it can't bloat the staged build input.
 */
function pruneRebuildArtifacts(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (!isStageableSource(entry.name)) {
      rmSync(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      pruneRebuildArtifacts(path);
    }
  }
}

function runNixBuild(
  nixPortable: string,
  mode: RuntimeMode,
  args: string[],
  logger: Logger,
): Promise<StreamingRunResult> {
  return runStreamingAsync(nixPortable, ["nix-build", ...args], {
    logger,
    label: "nix-build",
    env: { ...process.env, NP_RUNTIME: mode },
    classifyStderrLine: classifyNixBuildStderrLine,
  });
}

const NIX_BUILD_PROGRESS_LINE = /^these \d+ derivations? will be built/;

function classifyNixBuildStderrLine(line: string): StreamingLogLevel {
  if (
    line.startsWith("building") ||
    NIX_BUILD_PROGRESS_LINE.test(line) ||
    line.startsWith("downloading") ||
    line.startsWith("copying path")
  ) {
    return "info";
  }
  return "debug";
}

/** A pname Nix accepts (alnum, dot, dash, underscore). */
function sanitizePname(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/**
 * Locate the dustcastle-owned nix-portable binary, downloading it on first use
 * (ADR 0008 — dustcastle bundles/manages the rootless runtime). Tests inject an
 * existing binary via `spec.nixPortable` to avoid the download.
 */
export function ensureNixPortable(): string {
  const dir = join(homedir(), ".dustcastle", "bin");
  const bin = join(dir, "nix-portable");
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/DavHau/nix-portable/releases/latest/download/nix-portable-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
  const dl = spawnSync("curl", ["-fsSL", url, "-o", bin], { encoding: "utf8" });
  if (dl.status !== 0) throw new Error(`store: failed to download nix-portable:\n${dl.stderr}`);
  spawnSync("chmod", ["+x", bin]);
  return bin;
}
