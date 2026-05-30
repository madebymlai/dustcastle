import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Detection } from "../detect/index.js";
import { packageManagerDescriptor, type PackageManagerDescriptor } from "../ecosystems/index.js";
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
  /** The pip-FOD aggregate hash used for Python (discovered or supplied). Undefined for non-Python. */
  readonly pythonDepsHash?: string;
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

  // Route by the Package Manager descriptor in the Ecosystem Registry (ADR 0001:
  // internal curation, NOT a plugin system; ADR 0006: the lockfile names the
  // manager, the manager selects the importer). `detection.packageManager` is the
  // closed `PackageManager` union narrowed once at detection, and the Registry is
  // exhaustive over it by construction (architecture review candidate 2), so the
  // store's old defensive `default:`/Registry-miss guard has retired — the lookup's
  // own honest throw is the single never-drop-a-gate net (ADR 0004) if a caller
  // ever widens the type.
  const descriptor = packageManagerDescriptor(spec.detection.packageManager);

  // The honest provision gate (ADR 0001): bun carries one because nixpkgs has no
  // canonical bun deps importer yet. Throw its EXISTING actionable reason rather
  // than building it wrong (slice 2b caveat).
  if (descriptor.provisionGate !== undefined) {
    throw new Error(descriptor.provisionGate.reason);
  }

  return provision(spec, ctx, descriptor);
}

/** Shared per-provision state passed to the generic provisioner. */
interface BuildContext {
  readonly buildDir: string;
  readonly pname: string;
  readonly mode: RuntimeMode;
  readonly physStoreRoot: string;
  readonly run: (args: string[]) => { status: number | null; stdout: string; stderr: string };
}

/**
 * Provision one project from its Package Manager descriptor (collapses the old
 * provisionGo + provisionJs). The descriptor's `generateBuild` emits the importer
 * expression and declares the attribute names ({toolchain,deps,app}) to realize;
 * the two-pass discover-FOD-hash-then-build-offline flow (ADR 0004) is identical
 * across ecosystems. "Supports impure" is derived from the PRESENCE of an install-
 * script signal — node has one, go doesn't — reproducing today's Go vs JS branch.
 *
 * The output Provisioned hash shape is load-bearing at the run layer: Go's hash
 * lands in `vendorHash`, Node(pure)'s in `npmDepsHash`, impure-Node carries
 * neither. The descriptor's `outputHashField` names which field to populate.
 */
function provision(spec: ProvisionSpec, ctx: BuildContext, descriptor: PackageManagerDescriptor): Provisioned {
  const build = (depsHash: string) =>
    descriptor.generateBuild({
      pname: ctx.pname,
      depsHash,
      src: "./src",
      // Thread the resolved Toolchain version (ADR 0006b) so the importer builds
      // against the requested interpreter (Python; laimk-hse.3). Node/Go ignore it.
      ...(spec.detection.toolchainVersion !== undefined
        ? { toolchainVersion: spec.detection.toolchainVersion }
        : {}),
    });
  const attrs = build(FAKE_VENDOR_HASH).attrs;
  const write = (depsHash: string) =>
    writeFileSync(join(ctx.buildDir, "default.nix"), build(depsHash).expression);
  const realize = (attr: string) => parseStorePath(ctx.run(["-A", attr, "--no-out-link"]).stdout);
  // Only an ecosystem with an install-script signal (node) can build impure; go has
  // none, so it always takes the pure path even if a stray `impure` flag is set.
  const supportsImpure = descriptor.impuritySignal !== undefined;

  if (supportsImpure && spec.impure === true) {
    // Impure `allow` (ADR 0004/0005): realize only the Toolchain into the Store; the
    // container installs deps under scoped egress. A placeholder hash is fine —
    // `-A <toolchain>` never forces the deps derivation (Nix evaluates lazily).
    write(FAKE_VENDOR_HASH);
    const toolchain = ctx.run(["-A", attrs.toolchain, "--no-out-link"]);
    if (toolchain.status !== 0) {
      throw new Error(`store: toolchain build failed (exit ${toolchain.status}):\n${toolchain.stderr.slice(-2000)}`);
    }
    const toolchainStorePath = parseStorePath(toolchain.stdout);
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
    const probe = ctx.run(["-A", attrs.deps, "--no-out-link"]);
    depsHash = parseVendorHashMismatch(probe.stderr);
    if (depsHash === undefined) {
      throw new Error(`store: could not discover deps hash from build output:\n${probe.stderr.slice(-2000)}`);
    }
  }

  // Pass 2: build for real. `-A <app>` triggers the deps FOD + the offline test gate.
  write(depsHash);
  const app = ctx.run(["-A", attrs.app, "--no-out-link"]);
  if (app.status !== 0) {
    throw new Error(`store: build/offline-test failed (exit ${app.status}):\n${app.stderr.slice(-2000)}`);
  }

  // The hash lands in the field the descriptor declares (Go→vendorHash,
  // Node→npmDepsHash, Python→pythonDepsHash) — load-bearing at the run layer.
  // The Pass-1 discover / Pass-2 build loop above is REUSED unchanged: the pip-FOD
  // has one discoverable aggregate hash, so only the output field differs.
  return {
    mode: ctx.mode,
    physStoreRoot: ctx.physStoreRoot,
    toolchainStorePath: realize(attrs.toolchain),
    depsStorePath: realize(attrs.deps),
    appStorePath: parseStorePath(app.stdout),
    vendorHash: descriptor.outputHashField === "vendorHash" ? depsHash : "",
    ...(descriptor.outputHashField === "npmDepsHash" ? { npmDepsHash: depsHash } : {}),
    ...(descriptor.outputHashField === "pythonDepsHash" ? { pythonDepsHash: depsHash } : {}),
  };
}

// Names excluded from the staged build source: VCS metadata, nix build outputs,
// and per-ecosystem dependency/cache dirs that are rebuilt purely from the lockfile
// and never belong in the build (node's `node_modules`/Go's `vendor`, and Python's
// `.venv` + dev caches — the Python analogues, often hundreds of MB).
const STAGE_SKIP: ReadonlySet<string> = new Set([
  ".git",
  "vendor",
  "result",
  "node_modules",
  ".venv",
  ".tox",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
]);

/** Whether a source entry is staged into the build (false ⇒ excluded). */
export function isStageableSource(path: string): boolean {
  const name = basename(path);
  return !STAGE_SKIP.has(name) && !name.startsWith("result-");
}

function stageSource(projectDir: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  // Stage the project source, excluding build artifacts and VCS metadata.
  cpSync(projectDir, dest, { recursive: true, filter: isStageableSource });
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
