import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `Ecosystem` and `Detection` now live in the Ecosystem Registry's type module
// (the Registry's output shape; ADR 0001) and are re-exported here so existing
// import paths (`from "../detect/index.js"`) keep working unchanged. The Registry
// types depend only on src/nix, so there is no import cycle back into detect.
import { ECOSYSTEMS, packageManagerDescriptor } from "../ecosystems/index.js";
import type { Detection, EcosystemDescriptor, PackageManager } from "../ecosystems/types.js";
export type { Detection, Ecosystem } from "../ecosystems/types.js";

/**
 * Detect the Ecosystem(s) of a directory by reading its files (ADR 0006).
 * A thin router: the lockfile is the signal that selects the importer.
 *
 * The Go special-case and the JS lockfile/importer tables have both dissolved
 * into ONE generic fold over the Ecosystem Registry's descriptors (ADR 0001) —
 * Go is just another descriptor. The file-scanning mechanics stay here as the
 * owned router (ADR 0006); each descriptor supplies the data (manifest markers,
 * its managers' lockfiles in precedence order, the default manager) and the
 * ecosystem-specific readers (declared `packageManager` field, toolchain version).
 */
export function detect(dir: string): Detection[] {
  const has = (name: string) => existsSync(join(dir, name));
  // Per-directory detection (ADR 0006d): a polyglot repo can surface more than
  // one ecosystem, so we accumulate across descriptors rather than early-return.
  const detections: Detection[] = [];
  for (const ecosystem of ECOSYSTEMS) {
    const detected = detectEcosystem(dir, has, ecosystem);
    if (detected !== undefined) detections.push(detected);
  }
  return detections;
}

/**
 * Detect one Ecosystem in a directory from its descriptor (ADR 0006). The
 * Ecosystem is present when a manifest marker OR any of its managers' lockfiles
 * is present. The package manager is chosen by precedence (ADR 0006d): an
 * explicit declaration beats an inferred lockfile (explicit > inferred), and
 * among lockfiles the descriptor's manager ordering IS the precedence (a richer
 * manager beats `package-lock.json`).
 */
function detectEcosystem(
  dir: string,
  has: (name: string) => boolean,
  ecosystem: EcosystemDescriptor,
): Detection | undefined {
  const manifestPresent = ecosystem.manifests.some(has);
  const lockfileManager = firstLockfileManager(has, ecosystem);
  if (!manifestPresent && lockfileManager === undefined) return undefined;

  // Read the primary manifest's text once (the first present marker — go.mod /
  // package.json) for the descriptor's declared-manager and toolchain readers.
  const manifest = readFirstPresent(dir, has, ecosystem.manifests);

  // Explicit declaration (node's `packageManager` field) wins; else the lockfile;
  // else the descriptor's default manager (ADR 0006d explicit > inferred).
  const declared = ecosystem.readDeclaredManager?.(manifest);
  const packageManager = declared ?? lockfileManager ?? ecosystem.defaultManager;
  const importer = packageManagerDescriptor(packageManager).importer;

  // Toolchain-version precedence is owned by the descriptor's reader (ADR 0006b):
  // node's explicit `devEngines.runtime` beats version files; go reads go.mod's
  // `go` line. Undefined when the ecosystem declares no reader or none applies.
  const toolchainVersion = ecosystem.readToolchainVersion?.({
    manifest,
    readVersionFile: (name) => readVersionFile(dir, has, name),
  });

  // A manifest with no lockfile is resolvable-but-unpinned: pin-then-pure (0006c).
  // This is structurally node-only — Go's manifests (go.mod/go.sum) ARE its
  // lockfiles, so a present Go manifest always implies a present lockfile.
  const loose = manifestPresent && lockfileManager === undefined;

  return {
    ecosystem: ecosystem.ecosystem,
    packageManager,
    importer,
    ...(toolchainVersion !== undefined ? { toolchainVersion } : {}),
    ...(loose ? { loose: true } : {}),
  };
}

/**
 * The package manager named by the first-present lockfile, in the descriptor's
 * precedence order (ADR 0006d): a manager's lockfiles are scanned in declared
 * order and managers are scanned in declared order, so the richer manager beats
 * `package-lock.json`. Undefined when no lockfile is present.
 */
function firstLockfileManager(
  has: (name: string) => boolean,
  ecosystem: EcosystemDescriptor,
): PackageManager | undefined {
  for (const manager of ecosystem.managers) {
    if (packageManagerDescriptor(manager).lockfiles.some(has)) return manager;
  }
  return undefined;
}

/** Read the trimmed text of the first present file from a list, if any. */
function readFirstPresent(
  dir: string,
  has: (name: string) => boolean,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    if (has(name)) return readFileSync(join(dir, name), "utf8");
  }
  return undefined;
}

/** Read an idiomatic version file's trimmed content (`.nvmrc`, `.node-version`). */
function readVersionFile(dir: string, has: (name: string) => boolean, name: string): string | undefined {
  if (!has(name)) return undefined;
  return readFileSync(join(dir, name), "utf8").trim();
}
