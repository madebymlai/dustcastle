import type { Detection } from "../detect/index.js";
import { storeHashOf, type Provisioned } from "../store/index.js";
import type { StoreClosure } from "../store/storePool.js";

export interface GcProjectKeyInput {
  readonly detection: Pick<Detection, "packageManager">;
  readonly provisioned: Pick<Provisioned, "toolchainStorePath">;
}

/**
 * A stable key for the realized Toolchain closure this run pins (ADR 0007/0012).
 * The Store realizes only Toolchains now, so the key names the physical closure by
 * package manager plus the Toolchain store hash. Projects sharing one Toolchain
 * share one recency/root record; different Toolchains no longer collide.
 */
export function gcProjectKey(prepared: GcProjectKeyInput): string {
  return `${prepared.detection.packageManager}-${storeHashOf(prepared.provisioned.toolchainStorePath)}`;
}

/**
 * Map every active Ecosystem's Toolchain closure into the Store pool's key space.
 * The Map key is the GC project key, so duplicate Ecosystem entries resolving to
 * the same key naturally collapse to a single closure record.
 */
export function storeClosures(
  ecosystems: readonly GcProjectKeyInput[],
): Map<string, StoreClosure> {
  const closures = new Map<string, StoreClosure>();
  for (const ecosystem of ecosystems) {
    closures.set(gcProjectKey(ecosystem), ecosystem.provisioned);
  }
  return closures;
}
