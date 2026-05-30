import { generateNodeBuild } from "../nix/node.js";
import { generatePnpmBuild } from "../nix/pnpm.js";
import { generateYarnBuild } from "../nix/yarn.js";
import { npmLockNeedsImpurity, pnpmLockNeedsImpurity } from "../impurity/index.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

/**
 * The Node Ecosystem descriptors (ADR 0006). One Ecosystem, four Package Managers
 * (npm/pnpm/yarn/bun). Each manager's descriptor encodes — in one place — its
 * Importer, lockfile(s), impurity signal, and pin-then-pure resolve, exactly
 * reproducing today's per-site switches.
 */

const npm: PackageManagerDescriptor = {
  packageManager: "npm",
  ecosystem: "node",
  lockfiles: ["package-lock.json"],
  generateBuild: (ctx) =>
    generateNodeBuild({
      pname: ctx.pname,
      npmDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  outputHashField: "npmDepsHash",
  // npm's lockfile (v2/v3) records `hasInstallScript: true` on any package with an
  // install/preinstall/postinstall script (ADR 0004).
  impuritySignal: {
    lockfile: "package-lock.json",
    needsImpurity: (lockText) => npmLockNeedsImpurity(parseJsonOr(lockText)),
  },
  // npm exposes a first-class lockfile-only resolve (ADR 0006c).
  lockOnlyResolve: {
    kind: "command",
    command: "npm",
    args: ["install", "--package-lock-only"],
    lockfile: "package-lock.json",
  },
  // The impure in-container install (ADR 0004/0005): `npm ci` installs strictly
  // from the committed package-lock.json (frozen), running postinstall under scoped egress.
  impureInstall: ["npm ci"],
};

const pnpm: PackageManagerDescriptor = {
  packageManager: "pnpm",
  ecosystem: "node",
  lockfiles: ["pnpm-lock.yaml"],
  generateBuild: (ctx) =>
    generatePnpmBuild({
      pname: ctx.pname,
      depsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  outputHashField: "npmDepsHash",
  // pnpm's equivalent of hasInstallScript is `requiresBuild: true` (ADR 0004).
  impuritySignal: {
    lockfile: "pnpm-lock.yaml",
    needsImpurity: (lockText) => pnpmLockNeedsImpurity(lockText),
  },
  // pnpm exposes a first-class lockfile-only resolve (ADR 0006c).
  lockOnlyResolve: {
    kind: "command",
    command: "pnpm",
    args: ["install", "--lockfile-only"],
    lockfile: "pnpm-lock.yaml",
  },
  // The impure in-container install (ADR 0004/0005): frozen to pnpm-lock.yaml.
  impureInstall: ["pnpm install --frozen-lockfile"],
};

const yarn: PackageManagerDescriptor = {
  packageManager: "yarn",
  ecosystem: "node",
  lockfiles: ["yarn.lock"],
  generateBuild: (ctx) =>
    generateYarnBuild({
      pname: ctx.pname,
      depsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  outputHashField: "npmDepsHash",
  // yarn.lock (v1) carries NO install-script metadata — yarn's build policy lives
  // in package.json#dependenciesMeta.built / .yarnrc, not the lockfile — so a yarn
  // project always resolves pure. Present-but-always-false: honest, not a gap
  // (faking a signal the lockfile can't carry would be worse). ADR 0004.
  impuritySignal: {
    lockfile: "yarn.lock",
    needsImpurity: () => false,
  },
  // yarn classic has no clean lockfile-only resolve, so it is gated honestly
  // rather than running a full install just to pin (ADR 0006c, the bun-gate pattern).
  lockOnlyResolve: {
    kind: "gated",
    reason:
      "pin-then-pure: yarn has no clean lockfile-only resolve — commit a yarn.lock, or use " +
      "npm/pnpm, to build pure (ADR 0006c). dustcastle won't run a full yarn install just to pin.",
  },
  // The impure in-container install (ADR 0004/0005): frozen to yarn.lock. (yarn's
  // signal is present-but-always-false, but the install is carried for uniformity.)
  impureInstall: ["yarn install --frozen-lockfile"],
};

const bun: PackageManagerDescriptor = {
  packageManager: "bun",
  ecosystem: "node",
  lockfiles: ["bun.lockb", "bun.lock"],
  // bun has no canonical nixpkgs importer (provisionGate fires before this runs);
  // we still wire a generator so the dispatch surface stays uniform. It reuses the
  // npm build shape — never actually realized in v1.
  generateBuild: (ctx) =>
    generateNodeBuild({
      pname: ctx.pname,
      npmDepsHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  outputHashField: "npmDepsHash",
  // bun is gated at provision; the lockfile carries no script signal either, so
  // the signal is present-but-always-false (settled by design, ADR 0004).
  impuritySignal: {
    lockfile: "bun.lock",
    needsImpurity: () => false,
  },
  // The honest provision gate (ADR 0001/0006): nixpkgs has no canonical bun deps
  // importer (no fetchBunDeps analogue to fetchPnpmDeps/fetchYarnDeps), so there's
  // no hermetic, hash-pinned way to assemble node_modules from bun.lock yet.
  provisionGate: {
    reason:
      "store: the bun importer is not yet supported — nixpkgs has no canonical " +
      "bun deps importer (slice 2b: pnpm and yarn are supported). Use npm, pnpm, " +
      "or yarn, or track the bun-importer follow-up.",
  },
  // The impure in-container install (ADR 0004/0005): frozen to bun.lock. Carried
  // for uniformity though bun's provisionGate fires first (exactly like its
  // never-realized generateBuild) — a half-added manager stays honest.
  impureInstall: ["bun install --frozen-lockfile"],
};

// Keyed by Package Manager name for the Registry's compile-time exhaustiveness
// check (architecture review candidate 2). Insertion order = lockfile precedence.
export const NODE_MANAGERS = { bun, pnpm, yarn, npm } satisfies Partial<
  Record<PackageManager, PackageManagerDescriptor>
>;

export const NODE_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "node",
  manifests: ["package.json"],
  // The ordering IS the lockfile precedence (ADR 0006d): bun.lockb, bun.lock,
  // pnpm-lock.yaml, yarn.lock, package-lock.json — a richer manager beats npm.
  managers: ["bun", "pnpm", "yarn", "npm"],
  defaultManager: "npm",
  readDeclaredManager: (manifest) => readPackageManager(manifest),
  // Toolchain-version precedence (ADR 0006b): the explicit `devEngines.runtime`
  // contract wins, then the version files (.nvmrc, .node-version).
  readToolchainVersion: ({ manifest, readVersionFile }) =>
    readDevEnginesNodeVersion(manifest) ?? readNodeVersion(readVersionFile),
  // Pure staging (ADR 0002): the deps FOD publishes `node_modules`, copied into
  // the worktree's `node_modules` (manager-agnostic — every JS importer publishes
  // the same layout). The run env puts the node Toolchain on PATH ahead of the
  // agent harness (/usr/local/bin: bd/pi) and points npm's cache + home at /tmp,
  // since the Store is read-only.
  sandbox: {
    stageDir: "node_modules",
    storeSubpath: "node_modules",
    env: (bin) => ({
      // Nix Toolchain first (the PROJECT's node wins), then /usr/local/bin where
      // the image's agent harness lives (bd/pi — the implement phase shells `bd`).
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      // The Store is read-only; npm's cache + home must point somewhere writable.
      NPM_CONFIG_CACHE: "/tmp/npm-cache",
      XDG_CACHE_HOME: "/tmp/.cache",
      npm_config_update_notifier: "false",
    }),
  },
};

/** Parse the package-manager name from package.json's `packageManager` field. */
function readPackageManager(manifest: string | undefined): PackageManager | undefined {
  const pkg = parseJsonOr(manifest) as { packageManager?: unknown } | undefined;
  if (pkg === undefined || typeof pkg.packageManager !== "string") return undefined;
  const name = pkg.packageManager.split("@", 1)[0]?.trim();
  if (name === undefined || name.length === 0) return undefined;
  // Only a curated manager counts; an unknown name falls back to lockfile inference.
  return isNodeManager(name) ? name : undefined;
}

/**
 * Read the Node version from package.json's strict `devEngines.runtime` contract
 * (ADR 0006b). `runtime` may be a single object or an array; we pick the entry
 * whose `name` is `node` and return its `version`. Undefined when absent/malformed.
 */
function readDevEnginesNodeVersion(manifest: string | undefined): string | undefined {
  const pkg = parseJsonOr(manifest) as { devEngines?: { runtime?: unknown } } | undefined;
  const runtime = pkg?.devEngines?.runtime;
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
 * `.nvmrc` first, then `.node-version`. A leading `v` is stripped.
 */
function readNodeVersion(readVersionFile: (name: string) => string | undefined): string | undefined {
  for (const file of [".nvmrc", ".node-version"]) {
    const raw = readVersionFile(file)?.trim();
    if (raw !== undefined && raw.length > 0) return raw.replace(/^v/, "");
  }
  return undefined;
}

const NODE_MANAGER_NAMES = new Set<string>(["npm", "pnpm", "yarn", "bun"]);
function isNodeManager(name: string): name is PackageManager {
  return NODE_MANAGER_NAMES.has(name);
}

function parseJsonOr(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
