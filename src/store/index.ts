import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Detection } from "../detect/index.js";
import { generateGoBuild } from "../nix/go.js";
import { generateNodeBuild } from "../nix/node.js";
import { generatePnpmBuild } from "../nix/pnpm.js";
import { generateYarnBuild } from "../nix/yarn.js";
import { parseStorePath, parseVendorHashMismatch } from "./parse.js";
import { physPath } from "./paths.js";
import { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

export { physPath } from "./paths.js";
export { parseVendorHashMismatch, parseStorePath } from "./parse.js";
export { chooseRuntimeMode, unprivilegedUsernsAvailable, type RuntimeMode } from "./runtime.js";

/** The canonical placeholder hash used to provoke Nix into reporting the real one. */
const FAKE_VENDOR_HASH = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export interface ProvisionSpec {
  /** The project directory to provision (its source is staged into the build). */
  readonly projectDir: string;
  /** What detection concluded (ADR 0006) — selects the importer. */
  readonly detection: Detection;
  /**
   * Known Go vendor hash / Node npmDepsHash. When omitted, the store discovers
   * it via a placeholder build (ADR 0004 — v1 has no dynamic-derivations).
   */
  readonly vendorHash?: string;
  /**
   * Provision impurely (ADR 0004 `allow`): build only the Toolchain into the
   * Store and leave Project Deps to a container-side install under scoped egress.
   * Only meaningful for ecosystems with impure install scripts (Node).
   */
  readonly impure?: boolean;
  /** Path to the nix-portable binary (defaults to the dustcastle-owned copy). */
  readonly nixPortable?: string;
  /** Physical rootless store root (defaults to ~/.nix-portable/nix/store). */
  readonly physStoreRoot?: string;
  /** Stream build output line-by-line (e.g. to surface progress). */
  readonly onLine?: (line: string) => void;
}

/** The realized Store paths for a project (ADR 0001/0008). */
export interface Provisioned {
  /** The active rootless runtime, surfaced — never silent (ADR 0008). */
  readonly mode: RuntimeMode;
  /** Physical store root on the host (for staging into the Sandbox). */
  readonly physStoreRoot: string;
  /** Canonical /nix/store path of the language Toolchain. */
  readonly toolchainStorePath: string;
  /** Canonical /nix/store path of the Project Deps (vendored modules). */
  readonly depsStorePath: string;
  /** Canonical /nix/store path of the built app (its build ran the offline test). */
  readonly appStorePath: string;
  /** The Go vendor hash used (discovered or supplied). Empty for non-Go. */
  readonly vendorHash: string;
  /** The npm deps hash used for Node (discovered or supplied). Undefined for non-Node. */
  readonly npmDepsHash?: string;
}

/**
 * Realize a project's Toolchain + Project Deps into the rootless Store (ADR
 * 0004/0008). Builds the importer expression via nix-portable; the `app` build
 * also runs `go test` offline in the Nix sandbox — the first green gate. Returns
 * the canonical store paths plus the physical root and active runtime mode.
 */
export function provisionStore(spec: ProvisionSpec): Provisioned {
  const physStoreRoot = spec.physStoreRoot ?? join(homedir(), ".nix-portable", "nix", "store");
  const nixPortable = spec.nixPortable ?? ensureNixPortable();
  const mode = chooseRuntimeMode({ unprivilegedUserns: unprivilegedUsernsAvailable() });
  const pname = sanitizePname(basename(spec.projectDir));

  const buildDir = mkdtempSync(join(tmpdir(), "dustcastle-build-"));
  stageSource(spec.projectDir, join(buildDir, "src"));

  const run = (args: string[]) => runNixBuild(nixPortable, mode, [buildDir, ...args], spec.onLine);
  const ctx: BuildContext = { buildDir, pname, mode, physStoreRoot, run };

  switch (spec.detection.importer) {
    case "buildGoModule":
      return provisionGo(spec, ctx);
    case "fetchNpmDeps":
      return provisionJs(spec, ctx, "npm", (hash) =>
        generateNodeBuild({ pname: ctx.pname, npmDepsHash: hash, src: "./src" }).expression,
      );
    case "fetchPnpmDeps":
      return provisionJs(spec, ctx, "pnpm", (hash) =>
        generatePnpmBuild({ pname: ctx.pname, depsHash: hash, src: "./src" }).expression,
      );
    case "fetchYarnDeps":
      return provisionJs(spec, ctx, "yarn", (hash) =>
        generateYarnBuild({ pname: ctx.pname, depsHash: hash, src: "./src" }).expression,
      );
    case "fetchBunDeps":
      // bun is an open research question: nixpkgs has no canonical bun deps
      // importer (no fetchBunDeps analogue to fetchPnpmDeps/fetchYarnDeps), so
      // there's no hermetic, hash-pinned way to assemble node_modules from
      // bun.lock yet. Detection still routes bun; provisioning gates it
      // explicitly rather than building it wrong (slice 2b caveat).
      throw new Error(
        "store: the bun importer is not yet supported — nixpkgs has no canonical " +
          "bun deps importer (slice 2b: pnpm and yarn are supported). Use npm, pnpm, " +
          "or yarn, or track the bun-importer follow-up.",
      );
    default:
      throw new Error(
        `store: unsupported importer ${spec.detection.importer} ` +
          `(v1 builds Go via buildGoModule and JS via fetchNpmDeps/fetchPnpmDeps/fetchYarnDeps)`,
      );
  }
}

/** Shared per-provision state passed to each ecosystem builder. */
interface BuildContext {
  readonly buildDir: string;
  readonly pname: string;
  readonly mode: RuntimeMode;
  readonly physStoreRoot: string;
  readonly run: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/** Go (slice 1): buildGoModule vendor FOD + offline `go test` gate. */
function provisionGo(spec: ProvisionSpec, ctx: BuildContext): Provisioned {
  const writeGo = (vendorHash: string) =>
    writeFileSync(
      join(ctx.buildDir, "default.nix"),
      generateGoBuild({ pname: ctx.pname, vendorHash, src: "./src" }).expression,
    );

  // Pass 1: discover the vendor hash if not supplied (ADR 0004).
  let vendorHash = spec.vendorHash;
  if (vendorHash === undefined) {
    writeGo(FAKE_VENDOR_HASH);
    const probe = ctx.run(["-A", "deps", "--no-out-link"]);
    vendorHash = parseVendorHashMismatch(probe.stderr);
    if (vendorHash === undefined) {
      throw new Error(
        `store: could not discover vendorHash from build output:\n${probe.stderr.slice(-2000)}`,
      );
    }
  }

  // Pass 2: build for real. `-A app` triggers the vendor FOD + the offline test.
  writeGo(vendorHash);
  const app = ctx.run(["-A", "app", "--no-out-link"]);
  if (app.status !== 0) {
    throw new Error(`store: build/offline-test failed (exit ${app.status}):\n${app.stderr.slice(-2000)}`);
  }

  return {
    mode: ctx.mode,
    physStoreRoot: ctx.physStoreRoot,
    toolchainStorePath: parseStorePath(ctx.run(["-A", "go", "--no-out-link"]).stdout),
    depsStorePath: parseStorePath(ctx.run(["-A", "deps", "--no-out-link"]).stdout),
    appStorePath: parseStorePath(app.stdout),
    vendorHash,
  };
}

/**
 * JS ecosystems (slices 2 + 2b): npm/pnpm/yarn. Each importer fixed-output-
 * fetches its lockfile deps (hash-pinned) and assembles node_modules offline with
 * lifecycle scripts skipped; the only thing that differs between managers is the
 * generated Nix expression, so the provision flow is shared here. In impure
 * `allow` mode the deps aren't pre-built — only the Toolchain is realized, and the
 * container runs a real install under scoped egress (ADR 0004/0005).
 *
 * `writeExpr(hash)` writes the manager's importer expression pinned to `hash`;
 * `manager` only labels diagnostics. The realized contract is identical across
 * managers (toolchain `nodejs`, deps `node_modules`), so the plan stages them the
 * same way regardless of which manager signalled.
 */
function provisionJs(
  spec: ProvisionSpec,
  ctx: BuildContext,
  manager: string,
  writeExpr: (depsHash: string) => string,
): Provisioned {
  // Always realize the nodejs Toolchain. A placeholder hash is fine here because
  // `-A nodejs` never forces the deps derivation (Nix evaluates lazily).
  const write = (depsHash: string) => writeFileSync(join(ctx.buildDir, "default.nix"), writeExpr(depsHash));

  if (spec.impure === true) {
    write(FAKE_VENDOR_HASH);
    const nodejs = ctx.run(["-A", "nodejs", "--no-out-link"]);
    if (nodejs.status !== 0) {
      throw new Error(`store: nodejs toolchain build failed (exit ${nodejs.status}):\n${nodejs.stderr.slice(-2000)}`);
    }
    const toolchainStorePath = parseStorePath(nodejs.stdout);
    return {
      mode: ctx.mode,
      physStoreRoot: ctx.physStoreRoot,
      toolchainStorePath,
      depsStorePath: "", // deps install in the container (impure); not in the Store
      appStorePath: toolchainStorePath,
      vendorHash: "",
    };
  }

  // Pure path. Pass 1: discover the deps hash if not supplied (ADR 0004).
  let depsHash = spec.vendorHash;
  if (depsHash === undefined) {
    write(FAKE_VENDOR_HASH);
    const probe = ctx.run(["-A", "deps", "--no-out-link"]);
    depsHash = parseVendorHashMismatch(probe.stderr);
    if (depsHash === undefined) {
      throw new Error(
        `store: could not discover ${manager} deps hash from build output:\n${probe.stderr.slice(-2000)}`,
      );
    }
  }

  // Pass 2: assemble node_modules offline against the hash-pinned cache.
  write(depsHash);
  const deps = ctx.run(["-A", "deps", "--no-out-link"]);
  if (deps.status !== 0) {
    throw new Error(`store: offline ${manager} install failed (exit ${deps.status}):\n${deps.stderr.slice(-2000)}`);
  }
  const depsStorePath = parseStorePath(deps.stdout);

  return {
    mode: ctx.mode,
    physStoreRoot: ctx.physStoreRoot,
    toolchainStorePath: parseStorePath(ctx.run(["-A", "nodejs", "--no-out-link"]).stdout),
    depsStorePath,
    appStorePath: depsStorePath,
    vendorHash: "",
    npmDepsHash: depsHash,
  };
}

function stageSource(projectDir: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  // Stage the project source, excluding build artifacts and VCS metadata.
  const skip = new Set([".git", "vendor", "result", "node_modules"]);
  cpSync(projectDir, dest, {
    recursive: true,
    filter: (src) => !skip.has(basename(src)) && !basename(src).startsWith("result-"),
  });
}

function runNixBuild(
  nixPortable: string,
  mode: RuntimeMode,
  args: string[],
  onLine?: (line: string) => void,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(nixPortable, ["nix-build", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NP_RUNTIME: mode },
  });
  if (onLine && result.stderr) for (const line of result.stderr.split("\n")) onLine(line);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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
