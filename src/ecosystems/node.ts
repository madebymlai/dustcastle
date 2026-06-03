import { generateNodeToolchain } from "./toolchain-nix.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

/**
 * The Node Ecosystem descriptors (ADR 0006/0012). One Ecosystem, four Package
 * Managers (npm/pnpm/yarn/bun). Each manager's descriptor encodes — in one place —
 * its Toolchain expression, lockfile(s), in-Sandbox install command, and registry
 * host. Every manager installs impurely in-Sandbox; bun has no gate any more.
 */

const npm: PackageManagerDescriptor = {
  packageManager: "npm",
  ecosystem: "node",
  lockfiles: ["package-lock.json"],
  // Node's Toolchain is nixpkgs' `nodejs`; the manager name does not change it.
  generateToolchain: generateNodeToolchain,
  // The in-Sandbox install (ADR 0012): `npm install` works whether or not a lockfile
  // is committed — it installs from a satisfying package-lock.json when present, and
  // resolves when absent (a loose repo). We do NOT use `npm ci`: it hard-fails without
  // a lockfile, which is exactly the common loose case. Reproducibility is out of scope
  // (ADR 0012), so the resolving install is the single path. postinstall runs under the
  // standing egress either way.
  installCommand: ["npm install"],
  // Build Egress (ADR 0012): the registry `npm install` fetches from.
  registryHosts: ["registry.npmjs.org"],
};

const pnpm: PackageManagerDescriptor = {
  packageManager: "pnpm",
  ecosystem: "node",
  lockfiles: ["pnpm-lock.yaml"],
  // pnpm shares Node's `nodejs` Toolchain — the manager only changes the install.
  generateToolchain: generateNodeToolchain,
  // The in-Sandbox install (ADR 0012): `pnpm install` resolves with or without a
  // committed pnpm-lock.yaml — no `--frozen-lockfile`, which errors when the lock is
  // absent/outdated (the loose case must still install).
  installCommand: ["pnpm install"],
  // Build Egress (ADR 0012): pnpm fetches from the npm registry too.
  registryHosts: ["registry.npmjs.org"],
};

const yarn: PackageManagerDescriptor = {
  packageManager: "yarn",
  ecosystem: "node",
  lockfiles: ["yarn.lock"],
  // yarn shares Node's `nodejs` Toolchain — the manager only changes the install.
  generateToolchain: generateNodeToolchain,
  // The in-Sandbox install (ADR 0012): `yarn install` resolves with or without a
  // committed yarn.lock — no `--frozen-lockfile`, which errors when the lock is
  // absent/outdated (the loose case must still install).
  installCommand: ["yarn install"],
  // Build Egress (ADR 0012): yarn classic's own registry.
  registryHosts: ["registry.yarnpkg.com"],
};

const bun: PackageManagerDescriptor = {
  packageManager: "bun",
  ecosystem: "node",
  lockfiles: ["bun.lockb", "bun.lock"],
  // bun shares Node's `nodejs` Toolchain.
  generateToolchain: generateNodeToolchain,
  // The in-Sandbox install (ADR 0012): `bun install` resolves with or without a
  // committed bun.lock — no `--frozen-lockfile`, which errors when the lock is absent
  // (the loose case must still install). bun installs through the normal path like
  // every other manager — no gate, because there is no FOD importer to be missing any
  // more (the real install runs in-Sandbox).
  installCommand: ["bun install"],
  // Build Egress (ADR 0012): bun uses the npm registry.
  registryHosts: ["registry.npmjs.org"],
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
  // In-Sandbox install staging (ADR 0002/0012): the install assembles
  // `node_modules` in the worktree (manager-agnostic — every JS manager uses the
  // same layout). The run env puts the node Toolchain on PATH ahead of the agent
  // harness (/usr/local/bin: bd/pi) and points npm's cache + home at /tmp, since
  // the Store is read-only.
  sandbox: {
    stageDir: "node_modules",
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
