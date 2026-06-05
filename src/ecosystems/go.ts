import { generateGoToolchain } from "./toolchain-nix.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

// -----------------------------------------------------------------------------
// Managers
// -----------------------------------------------------------------------------

/**
 * The Go Ecosystem descriptors (ADR 0006). A single Package Manager (`go`) — still
 * a Package Manager, not a special case (CONTEXT.md). Its Toolchain is nixpkgs' `go`;
 * its modules are fetched in-Sandbox via `go mod download` (ADR 0012).
 */

const go: PackageManagerDescriptor = {
  packageManager: "go",
  ecosystem: "go",
  lockfiles: ["go.sum", "go.mod"],
  generateToolchain: generateGoToolchain,
  // The Go module proxy — the standing Build Egress for a go repo (ADR 0012). ONE host:
  // `go mod download` fetches modules from proxy.golang.org and verifies them against the
  // COMMITTED go.sum locally, so the checksum DB (sum.golang.org) is never contacted on
  // the frozen-lockfile path — proven by the e2e proxy log (only proxy.golang.org is hit).
  // registryHosts is required + non-empty on every descriptor now that egress no longer
  // branches on purity.
  registryHosts: ["proxy.golang.org"],
  // The in-Sandbox install (ADR 0012 always-impure): `go mod download` fetches the
  // committed modules from the module proxy into GOMODCACHE, so `go test` runs
  // against real deps. Every detected Ecosystem installs in-Sandbox now, so go
  // carries an install command too.
  installCommand: ["go mod download"],
};

// Keyed by Package Manager name so the Registry can prove — at tsc — that every
// PackageManager has a descriptor (architecture review candidate 2). `satisfies`
// keeps the precise key literals while constraining them to the closed union.
export const GO_MANAGERS = { go } satisfies Partial<Record<PackageManager, PackageManagerDescriptor>>;

// -----------------------------------------------------------------------------
// Ecosystem descriptor
// -----------------------------------------------------------------------------

export const GO_ECOSYSTEM: EcosystemDescriptor = {
  ecosystem: "go",
  manifests: ["go.mod", "go.sum"],
  managers: ["go"],
  defaultManager: "go",
  // No declared-manager resolver: Go has a single Package Manager.
  // The Toolchain version comes from go.mod's `go` line (ADR 0006b).
  readToolchainVersion: ({ manifest }) => readGoVersion(manifest),
  // In-Sandbox install staging (ADR 0012): `go mod download` populates GOMODCACHE
  // (vendor stays the conventional stage dir for the worktree git-exclude). The run
  // env (spike-proven) leaves the module proxy ON so the in-Sandbox install reaches
  // it, and points the module + build caches at writable /tmp off the read-only Store.
  sandbox: {
    stageDir: "vendor",
    env: (bin) => ({
      PATH: `${bin}:/usr/bin:/bin`,
      GOTOOLCHAIN: "local",
      CGO_ENABLED: "0",
      GOCACHE: "/tmp/gocache",
      GOMODCACHE: "/tmp/gomodcache",
      GOENV: "off",
    }),
  },
};

// -----------------------------------------------------------------------------
// Loose detection
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// Version resolution
// -----------------------------------------------------------------------------

/** Parse the `go 1.x[.y]` directive from a go.mod, if present. */
function readGoVersion(manifest: string | undefined): string | undefined {
  if (manifest === undefined) return undefined;
  const match = manifest.match(/^go\s+(\d+\.\d+(?:\.\d+)?)/m);
  return match?.[1];
}
