import { generateGoBuild } from "../nix/go.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

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

// Keyed by Package Manager name so the Registry can prove — at tsc — that every
// PackageManager has a descriptor (architecture review candidate 2). `satisfies`
// keeps the precise key literals while constraining them to the closed union.
export const GO_MANAGERS = { go } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

export const GO_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "go",
  manifests: ["go.mod", "go.sum"],
  managers: ["go"],
  defaultManager: "go",
  // No declared-manager resolver: Go has a single Package Manager.
  // The Toolchain version comes from go.mod's `go` line (ADR 0006b).
  readToolchainVersion: ({ manifest }) => readGoVersion(manifest),
  // Pure staging (ADR 0002): go's deps Store path IS the vendor dir, so there is
  // no subpath — `stageCommands` copies the whole `depsStorePath` into the
  // worktree's `vendor` (GOFLAGS=-mod=vendor reads it). The run env (spike-proven)
  // reads vendored deps, turns the module proxy off, and points the build cache at
  // /tmp since the Store is read-only.
  sandbox: {
    stageDir: "vendor",
    storeSubpath: "",
    env: (bin) => ({
      PATH: `${bin}:/usr/bin:/bin`,
      GOFLAGS: "-mod=vendor",
      GOPROXY: "off",
      GOTOOLCHAIN: "local",
      CGO_ENABLED: "0",
      GOCACHE: "/tmp/gocache",
      GOENV: "off",
    }),
  },
};

/** Parse the `go 1.x[.y]` directive from a go.mod, if present. */
function readGoVersion(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const match = manifest.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return match?.[1];
}
