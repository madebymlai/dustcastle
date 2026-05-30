import { generateGoBuild } from "../nix/go.js";
import type { EcosystemDescriptor, PackageManagerDescriptor } from "./types.js";

/**
 * The Go Ecosystem descriptors (ADR 0006). A single Package Manager (`go`) — still
 * a Package Manager, not a special case (CONTEXT.md). buildGoModule splits into a
 * vendor FOD + an offline build/test; the discovered hash lands in `vendorHash`.
 *
 * Go has NO impuritySignal (only Node has impure install scripts in v1) and NO
 * lockOnlyResolve (go.mod/go.sum is already a real lockfile — nothing to pin).
 */

const go: PackageManagerDescriptor = {
  packageManager: "go",
  ecosystem: "go",
  importer: "buildGoModule",
  lockfiles: ["go.sum", "go.mod"],
  generateBuild: (ctx) =>
    generateGoBuild({
      pname: ctx.pname,
      vendorHash: ctx.depsHash,
      ...(ctx.src !== undefined ? { src: ctx.src } : {}),
    }),
  outputHashField: "vendorHash",
  // No impuritySignal, no lockOnlyResolve, no provisionGate — Go builds pure.
};

export const GO_MANAGERS: readonly PackageManagerDescriptor[] = [go];

export const GO_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "go",
  manifests: ["go.mod", "go.sum"],
  managers: ["go"],
  defaultManager: "go",
  // No declared-manager resolver: Go has a single Package Manager.
  // The Toolchain version comes from go.mod's `go` line (ADR 0006b).
  readToolchainVersion: ({ manifest }) => readGoVersion(manifest),
};

/** Parse the `go 1.x[.y]` directive from a go.mod, if present. */
function readGoVersion(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const match = manifest.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return match?.[1];
}
