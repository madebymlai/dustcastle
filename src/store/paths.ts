/** The canonical in-namespace store prefix every Nix store path carries. */
const NIX_STORE_PREFIX = "/nix/store/";

/**
 * Translate a canonical `/nix/store/<path>` to its physical location under the
 * rootless store root (ADR 0008). nix-portable presents the store at
 * `/nix/store` via a user namespace, but on the host the files live under a
 * dustcastle-owned per-user dir; staging into the Sandbox needs the real path.
 */
export function physPath(physStoreRoot: string, storePath: string): string {
  const root = physStoreRoot.replace(/\/+$/, "");
  const rel = storePath.startsWith(NIX_STORE_PREFIX)
    ? storePath.slice(NIX_STORE_PREFIX.length)
    : storePath.replace(/^\/+/, "");
  return `${root}/${rel}`;
}
