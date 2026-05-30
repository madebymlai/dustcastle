import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A language world dustcastle can provision (CONTEXT.md glossary: Ecosystem). */
export type Ecosystem = "go" | "node";

/**
 * What detection concludes about one directory: which Ecosystem it is, the
 * package manager that signalled it, and therefore the Nix importer to run
 * (ADR 0006 — the lockfile names the manager, which selects the importer).
 */
export interface Detection {
  readonly ecosystem: Ecosystem;
  readonly packageManager: string;
  readonly importer: string;
  /**
   * The runtime version the repo asks for, read from version files / manifests
   * (ADR 0006b). The lockfile names the importer but not the toolchain version;
   * for Go that comes from go.mod's `go` line. Undefined when unspecified.
   */
  readonly toolchainVersion?: string;
  /**
   * A resolvable-but-unpinned manifest: a `package.json` with no lockfile (ADR
   * 0006c). dustcastle resolves it once into a generated lock, then builds pure —
   * strictly better than going impure. Undefined/false when a lockfile pins it.
   */
  readonly loose?: boolean;
}

/**
 * Detect the Ecosystem(s) of a directory by reading its files (ADR 0006).
 * A thin router: the lockfile is the signal that selects the importer.
 */
export function detect(dir: string): Detection[] {
  const has = (name: string) => existsSync(join(dir, name));
  const detections: Detection[] = [];

  // Go (slice 1). Per-directory detection (ADR 0006d): a polyglot repo can
  // surface more than one ecosystem, so we accumulate rather than early-return.
  if (has("go.mod") || has("go.sum")) {
    const toolchainVersion = readGoVersion(join(dir, "go.mod"));
    detections.push({
      ecosystem: "go",
      packageManager: "go",
      importer: "buildGoModule",
      ...(toolchainVersion !== undefined ? { toolchainVersion } : {}),
    });
  }

  // Node / JS (slice 2).
  const node = detectNode(dir, has);
  if (node !== undefined) detections.push(node);

  return detections;
}

/**
 * JS lockfile → package manager, in CNB/Paketo precedence order (ADR 0006d):
 * a richer manager's lockfile beats `package-lock.json` (npm). First match wins.
 */
const JS_LOCKFILES: ReadonlyArray<{ readonly file: string; readonly pm: string }> = [
  { file: "bun.lockb", pm: "bun" },
  { file: "bun.lock", pm: "bun" },
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "package-lock.json", pm: "npm" },
];

/** Package manager → Nix importer (ADR 0006a). The lockfile names the manager. */
const JS_IMPORTERS: Readonly<Record<string, string>> = {
  npm: "fetchNpmDeps",
  pnpm: "fetchPnpmDeps",
  yarn: "fetchYarnDeps",
  bun: "fetchBunDeps",
};

/**
 * Detect a JS/Node ecosystem in a directory (ADR 0006). A repo is JS when it has
 * a `package.json` or any JS lockfile. The package manager is chosen by
 * precedence: an explicit `packageManager` field beats an inferred lockfile
 * (explicit > inferred), and among lockfiles bun/pnpm/yarn beat npm.
 */
function detectNode(dir: string, has: (name: string) => boolean): Detection | undefined {
  const hasManifest = has("package.json");
  const lockfile = JS_LOCKFILES.find((entry) => has(entry.file));
  if (!hasManifest && lockfile === undefined) return undefined;

  // Explicit `packageManager` (e.g. "yarn@4.1.0") wins; else the lockfile; else npm.
  const declared = hasManifest ? readPackageManager(join(dir, "package.json")) : undefined;
  const packageManager = declared ?? lockfile?.pm ?? "npm";
  const importer = JS_IMPORTERS[packageManager] ?? "fetchNpmDeps";
  // Toolchain-version precedence (ADR 0006b): the explicit, manifest-declared
  // `devEngines.runtime` contract wins, then the version files (.nvmrc, .node-version).
  const toolchainVersion =
    (hasManifest ? readDevEnginesNodeVersion(join(dir, "package.json")) : undefined) ??
    readNodeVersion(dir, has);
  // A manifest with no lockfile is resolvable-but-unpinned: pin-then-pure (0006c).
  const loose = hasManifest && lockfile === undefined;

  return {
    ecosystem: "node",
    packageManager,
    importer,
    ...(toolchainVersion !== undefined ? { toolchainVersion } : {}),
    ...(loose ? { loose: true } : {}),
  };
}

/** Parse the package-manager name from package.json's `packageManager` field. */
function readPackageManager(packageJsonPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { packageManager?: unknown };
    if (typeof pkg.packageManager !== "string") return undefined;
    const name = pkg.packageManager.split("@", 1)[0]?.trim();
    return name !== undefined && name.length > 0 ? name : undefined;
  } catch {
    return undefined; // malformed package.json — fall back to lockfile inference
  }
}

/**
 * Read the Node version from package.json's strict `devEngines.runtime` contract
 * (ADR 0006b). `runtime` may be a single object or an array; we pick the entry
 * whose `name` is `node` and return its `version`. Undefined when absent/malformed
 * or when no node runtime is declared.
 */
function readDevEnginesNodeVersion(packageJsonPath: string): string | undefined {
  let pkg: { devEngines?: { runtime?: unknown } };
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { devEngines?: { runtime?: unknown } };
  } catch {
    return undefined;
  }
  const runtime = pkg.devEngines?.runtime;
  const entries = Array.isArray(runtime) ? runtime : runtime !== undefined ? [runtime] : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { name, version } = entry as { name?: unknown; version?: unknown };
    if (name === "node" && typeof version === "string" && version.trim().length > 0) {
      return version.trim().replace(/^v/, "");
    }
  }
  return undefined;
}

/**
 * Read the requested Node version from the idiomatic version files (ADR 0006b):
 * `.nvmrc` first, then `.node-version`. A leading `v` is stripped. Undefined when
 * neither file is present.
 */
function readNodeVersion(dir: string, has: (name: string) => boolean): string | undefined {
  for (const file of [".nvmrc", ".node-version"]) {
    if (!has(file)) continue;
    const raw = readFileSync(join(dir, file), "utf8").trim();
    if (raw.length > 0) return raw.replace(/^v/, "");
  }
  return undefined;
}

/** Parse the `go 1.x[.y]` directive from a go.mod, if present. */
function readGoVersion(goModPath: string): string | undefined {
  if (!existsSync(goModPath)) return undefined;
  const match = readFileSync(goModPath, "utf8").match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return match?.[1];
}
