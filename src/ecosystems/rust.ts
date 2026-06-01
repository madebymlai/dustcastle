import { CARGO_HOME_BASENAME, generateRustBuild } from "../nix/rust.js";
import { readRustToolchainVersion } from "./rust-version.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

/**
 * The Rust Ecosystem descriptors. Cargo is the sole Package Manager. A committed
 * Cargo.lock builds pure: fetchCargoVendor produces one aggregate cargoHash, then
 * the Sandbox stages the relocatable CARGO_HOME deps with the existing env-only
 * cp -RL path. A loose Cargo.toml pins first with cargo generate-lockfile.
 */

const cargo: PackageManagerDescriptor = {
  packageManager: "cargo",
  ecosystem: "rust",
  lockfiles: ["Cargo.lock"],
  generateBuild: (ctx) =>
    generateRustBuild({
      pname: ctx.pname,
      cargoHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  lockOnlyResolve: {
    kind: "command",
    command: "cargo",
    args: ["generate-lockfile"],
    lockfile: "Cargo.lock",
    // The host-side resolve runs deny-by-default (ADR 0005 / dustcastle-4ky): it
    // gets an isolated, throwaway CARGO_HOME and the shared env floor, PLUS the
    // rustup vars a `cargo` shim needs to resolve the toolchain. CARGO_NET_OFFLINE
    // is deliberately NOT passed through, so the one-time resolve runs online.
    execution: {
      isolatedHomeEnv: "CARGO_HOME",
      extraEnv: ["RUSTUP_HOME", "RUSTUP_TOOLCHAIN"],
    },
  },
  // No impuritySignal / impureInstall: Cargo builds pure unconditionally in v1.
};

export const RUST_MANAGERS = { cargo } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

export const RUST_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "rust",
  manifests: ["Cargo.toml", "Cargo.lock"],
  managers: ["cargo"],
  defaultManager: "cargo",
  readToolchainVersion: readRustToolchainVersion,
  // Generic loose detection covers Cargo.toml without Cargo.lock; cargo's
  // lockOnlyResolve pins it once before the pure vendored build.
  sandbox: {
    stageDir: CARGO_HOME_BASENAME,
    storeSubpath: "",
    env: (bin) => ({
      PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
      CARGO_HOME: CARGO_HOME_BASENAME,
      CARGO_NET_OFFLINE: "true",
      CARGO_TARGET_DIR: "/tmp/cargo-target",
    }),
  },
};
