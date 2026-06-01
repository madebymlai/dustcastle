import { GO_ECOSYSTEM, GO_MANAGERS } from "./go.js";
import { NODE_ECOSYSTEM, NODE_MANAGERS } from "./node.js";
import { PYTHON_ECOSYSTEM, PYTHON_MANAGERS } from "./python.js";
import { RUST_ECOSYSTEM, RUST_MANAGERS } from "./rust.js";
import type { EcosystemDescriptor, PackageManager, PackageManagerDescriptor } from "./types.js";

export type {
  BuildContext,
  Detection,
  Ecosystem,
  EcosystemDescriptor,
  ExportFrontEnd,
  ImpuritySignal,
  LockOnlyResolve,
  LooseManifestInput,
  PackageManager,
  PackageManagerDescriptor,
  ProvisionGate,
  SandboxStaging,
  ToolchainVersionInput,
} from "./types.js";

/**
 * The Ecosystem Registry (ADR 0001 — internal curation, NOT a plugin system; the
 * single, closed, vetted set of descriptors the detect/store/impurity/pin/nix
 * sites derive from). Adding an Ecosystem is dustcastle's deep, local change — the
 * user never configures one. A gated Package Manager (the bun gate) is a
 * first-class state in the Registry, not an ad-hoc throw.
 *
 * The ordering of {@link ECOSYSTEMS} is detection precedence (ADR 0006d): Go
 * first, then Node, then Python, then Rust — matching today's hardcoded `detect()`
 * accumulation order. Python and Rust are per-directory orthogonal (a polyglot
 * repo can surface them alongside Node/Go), so their slots are non-conflicting.
 */
export const ECOSYSTEMS: readonly EcosystemDescriptor[] = [
  GO_ECOSYSTEM,
  NODE_ECOSYSTEM,
  PYTHON_ECOSYSTEM,
  RUST_ECOSYSTEM,
];

/**
 * The Package Manager descriptors, keyed by manager and EXHAUSTIVE BY CONSTRUCTION
 * (architecture review candidate 2). The `Record<PackageManager, …>` annotation is
 * the compile-time proof: every member of the closed {@link PackageManager} union
 * must have a descriptor here, or this assignment fails at `tsc`. A half-added
 * Ecosystem — a manager in the union with no descriptor — can no longer compile and
 * fail at provision time; the dispatch sites (store/impurity/pin) derive from this
 * and are exhaustive without a runtime `default:` guard.
 */
const BY_PACKAGE_MANAGER: Record<PackageManager, PackageManagerDescriptor> = {
  ...GO_MANAGERS,
  ...NODE_MANAGERS,
  ...PYTHON_MANAGERS,
  ...RUST_MANAGERS,
};

const BY_ECOSYSTEM: ReadonlyMap<string, EcosystemDescriptor> = new Map(ECOSYSTEMS.map((e) => [e.ecosystem, e]));

/** The closed set of curated Package Manager names (the dispatch keys). */
export const PACKAGE_MANAGERS: readonly PackageManager[] = Object.keys(BY_PACKAGE_MANAGER) as PackageManager[];

/** Look up a Package Manager's descriptor (the dispatch grain). Throws on an unknown manager. */
export function packageManagerDescriptor(pm: PackageManager): PackageManagerDescriptor {
  const descriptor = BY_PACKAGE_MANAGER[pm];
  if (descriptor === undefined) {
    // Unreachable for the closed union, but honest if a caller widens the type.
    throw new Error(`ecosystems: unknown package manager ${pm} (not in the Registry)`);
  }
  return descriptor;
}

/** Look up an Ecosystem's descriptor (the detection grain). Throws on an unknown ecosystem. */
export function ecosystemFor(ecosystem: string): EcosystemDescriptor {
  const descriptor = BY_ECOSYSTEM.get(ecosystem);
  if (descriptor === undefined) {
    throw new Error(`ecosystems: unknown ecosystem ${ecosystem} (not in the Registry)`);
  }
  return descriptor;
}
