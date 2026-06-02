import { generateRustToolchain } from "./toolchain-nix.js";
import { readRustToolchainVersion } from "./rust-version.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

/**
 * Shared basename for Rust's writable, per-project CARGO_HOME (the descriptor's
 * `sandbox` stage dir + the store's stage-skip filter agree on it). The in-Sandbox
 * `cargo fetch` populates it; it is git-excluded like every other stage dir.
 */
export const CARGO_HOME_BASENAME = "dustcastle-cargo-home";

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
  // The crates index — the standing Build Egress for a cargo repo (ADR 0012).
  // registryHost is required on every descriptor now that egress no longer branches
  // on purity.
  registryHost: "index.crates.io",
  // The in-Sandbox install (ADR 0012 always-impure): `cargo fetch` downloads the
  // committed Cargo.lock's crates into CARGO_HOME, so `cargo test` runs offline
  // against them. Every detected Ecosystem installs in-Sandbox now, so cargo
  // carries an install command.
  installCommand: ["cargo fetch"],
};

export const RUST_MANAGERS = { cargo } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

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
