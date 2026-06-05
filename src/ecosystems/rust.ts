import { generateRustToolchain } from "./toolchain-nix.js";
import type {
  EcosystemDescriptor,
  PackageManager,
  PackageManagerDescriptor,
  ToolchainVersionInput,
} from "./types.js";

/**
 * Shared basename for Rust's writable, per-project CARGO_HOME (the descriptor's
 * `sandbox` stage dir + the store's stage-skip filter agree on it). The in-Sandbox
 * `cargo fetch` populates it; it is git-excluded like every other stage dir.
 */
export const CARGO_HOME_BASENAME = "dustcastle-cargo-home";

// -----------------------------------------------------------------------------
// Managers
// -----------------------------------------------------------------------------

/**
 * The Rust Ecosystem descriptors. Cargo is the sole Package Manager. Its Toolchain
 * is rustc + cargo + a C compiler from nixpkgs; its crates are fetched in-Sandbox via
 * `cargo fetch` into a writable CARGO_HOME (ADR 0012).
 */

const cargo: PackageManagerDescriptor = {
  packageManager: "cargo",
  ecosystem: "rust",
  lockfiles: ["Cargo.lock"],
  generateToolchain: generateRustToolchain,
  // The crates index + the crate download host — the standing Build Egress for a cargo
  // repo (ADR 0012). Both are required: `cargo fetch` reads the sparse index from
  // index.crates.io AND downloads crate tarballs from static.crates.io, so an allowlist
  // with only the index 403s the downloads. registryHosts is required + non-empty on
  // every descriptor now that egress no longer branches on purity.
  registryHosts: ["index.crates.io", "static.crates.io"],
  // The in-Sandbox install (ADR 0012 always-impure): `cargo fetch` downloads the
  // committed Cargo.lock's crates into CARGO_HOME, so `cargo test` runs offline
  // against them. Every detected Ecosystem installs in-Sandbox now, so cargo
  // carries an install command.
  installCommand: ["cargo fetch"],
};

export const RUST_MANAGERS = { cargo } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

// -----------------------------------------------------------------------------
// Ecosystem descriptor
// -----------------------------------------------------------------------------

export const RUST_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "rust",
  manifests: ["Cargo.toml", "Cargo.lock"],
  managers: ["cargo"],
  defaultManager: "cargo",
  readToolchainVersion: readRustToolchainVersion,
  // In-Sandbox install staging (ADR 0012): `cargo fetch` populates the writable
  // per-project CARGO_HOME basename (a loose Cargo.toml resolves in the same step).
  // Offline mode is OFF so the fetch reaches the crates index in-Sandbox; the build
  // cache points at writable /tmp.
  sandbox: {
    stageDir: CARGO_HOME_BASENAME,
    env: (bin) => ({
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      CARGO_HOME: CARGO_HOME_BASENAME,
      CARGO_TARGET_DIR: "/tmp/cargo-target",
    }),
  },
};

// -----------------------------------------------------------------------------
// Loose detection
// -----------------------------------------------------------------------------

// Rust has no separate loose-manifest reader: Cargo.toml is a valid detection
// manifest, and `cargo fetch` resolves either locked or loose projects in-Sandbox.

// -----------------------------------------------------------------------------
// Version resolution
// -----------------------------------------------------------------------------

const RUST_TOOLCHAIN_TOML = "rust-toolchain.toml";
const LEGACY_RUST_TOOLCHAIN = "rust-toolchain";
const TOOLCHAIN_TABLE = "toolchain";
const CHANNEL_KEY = "channel";

/**
 * Read Rust's requested Toolchain channel from rustup's idiomatic version files.
 * `rust-toolchain.toml` wins, then legacy bare `rust-toolchain`. Cargo.toml's
 * `rust-version` is deliberately ignored: it is the MSRV floor, not a pin.
 */
export function readRustToolchainVersion({ readVersionFile }: ToolchainVersionInput): string | undefined {
  const tomlChannel = readRustToolchainToml(readVersionFile(RUST_TOOLCHAIN_TOML));
  if (tomlChannel !== undefined) return tomlChannel;

  return nonEmpty(readVersionFile(LEGACY_RUST_TOOLCHAIN)?.trim());
}

/** Read `[toolchain] channel = "..."` from rust-toolchain.toml. */
export function readRustToolchainToml(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;

  let inToolchainTable = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = stripTomlComment(line).trim();
    if (trimmedLine.length === 0) continue;

    if (trimmedLine.startsWith("[")) {
      inToolchainTable = parseTomlTableHeader(trimmedLine) === TOOLCHAIN_TABLE;
      continue;
    }
    if (!inToolchainTable) continue;

    const assignment = parseTomlAssignment(trimmedLine);
    if (assignment?.key !== CHANNEL_KEY) continue;
    return readTomlScalar(assignment.value);
  }

  return undefined;
}

function parseTomlTableHeader(line: string): string | undefined {
  if (!line.startsWith("[") || !line.endsWith("]") || line.startsWith("[[")) return undefined;
  return nonEmpty(line.slice(1, -1).trim());
}

function parseTomlAssignment(line: string): { key: string; value: string } | undefined {
  const separator = line.indexOf("=");
  if (separator === -1) return undefined;

  return {
    key: line.slice(0, separator).trim(),
    value: line.slice(separator + 1).trim(),
  };
}

/** Drop a trailing `# comment` not inside a quoted string. */
function stripTomlComment(line: string): string {
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString !== undefined) {
      if (ch === inString) inString = undefined;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Strip matching single or double quotes from a TOML scalar; pass through otherwise. */
function readTomlScalar(value: string): string | undefined {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }

  return nonEmpty(value.trim());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
