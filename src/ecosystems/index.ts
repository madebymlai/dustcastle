import { GO_ECOSYSTEM, GO_MANAGERS } from "./go.js";
import { NODE_ECOSYSTEM, NODE_MANAGERS } from "./node.js";
import { PYTHON_ECOSYSTEM, PYTHON_MANAGERS } from "./python.js";
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
  OutputHashField,
  PackageManager,
  PackageManagerDescriptor,
  ProvisionGate,
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
 * first, then Node, then Python — matching today's hardcoded `detect()`
 * accumulation order. Python is per-directory orthogonal (a polyglot repo can
 * surface it alongside Node/Go), so its slot in the order is non-conflicting.
 */
export const ECOSYSTEMS: readonly EcosystemDescriptor[] = [GO_ECOSYSTEM, NODE_ECOSYSTEM, PYTHON_ECOSYSTEM];

/** Every Package Manager descriptor, flattened across Ecosystems (dispatch grain). */
const PACKAGE_MANAGER_DESCRIPTORS: readonly PackageManagerDescriptor[] = [
  ...GO_MANAGERS,
  ...NODE_MANAGERS,
  ...PYTHON_MANAGERS,
];

const BY_PACKAGE_MANAGER: ReadonlyMap<PackageManager, PackageManagerDescriptor> = new Map(
  PACKAGE_MANAGER_DESCRIPTORS.map((d) => [d.packageManager, d]),
);

const BY_ECOSYSTEM: ReadonlyMap<string, EcosystemDescriptor> = new Map(ECOSYSTEMS.map((e) => [e.ecosystem, e]));

/** The closed set of curated Package Manager names (the dispatch keys). */
export const PACKAGE_MANAGERS: readonly PackageManager[] = PACKAGE_MANAGER_DESCRIPTORS.map((d) => d.packageManager);

/** Look up a Package Manager's descriptor (the dispatch grain). Throws on an unknown manager. */
export function packageManagerDescriptor(pm: PackageManager): PackageManagerDescriptor {
  const descriptor = BY_PACKAGE_MANAGER.get(pm);
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
