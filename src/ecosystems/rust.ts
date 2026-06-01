import { CARGO_HOME_BASENAME, generateRustBuild } from "../nix/rust.js";
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
  },
  // No impuritySignal / impureInstall: Cargo builds pure unconditionally in v1.
};

export const RUST_MANAGERS = { cargo } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

export const RUST_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "rust",
  manifests: ["Cargo.toml", "Cargo.lock"],
  managers: ["cargo"],
  defaultManager: "cargo",
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
