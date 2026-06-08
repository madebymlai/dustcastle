import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { ProvisionedSandbox } from "./index.js";

export interface HostProvisioningOptions {
  /**
   * Accepted for interface compatibility with the Store bracket, but the host
   * bracket never provisions a Store and never calls this callback.
   */
  readonly onPrepared?: (prepared: never) => void;
}

/**
 * Host provisioning bracket for dustless mode. Builds a bare `noSandbox()` provider
 * and passes caller hooks through unchanged. Performs NONE of the Store/detection
 * /image/GC-root/deps-cache/auto-GC work. Satisfies the same body contract
 * ({@link ProvisionedSandbox} minus `prepared`) as `withProvisionedSandbox`.
 */
export async function withHostProvisioning<T>(
  body: (sandbox: ProvisionedSandbox) => Promise<T>,
  _opts?: HostProvisioningOptions,
): Promise<T> {
  const provider = noSandbox();
  return body({
    provider,
    withSetupHooks: (callerHooks) => callerHooks ?? {},
  });
}
