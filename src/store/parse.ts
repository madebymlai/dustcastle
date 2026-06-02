const NIX_STORE_PREFIX = "/nix/store/";

/**
 * Read the realized store path from `nix-build --no-out-link` stdout. With a
 * single `-A` attribute that's just the path; we take the last `/nix/store/…`
 * line to be robust to leading warnings. Throws if none is present.
 */
export function parseStorePath(stdout: string): string {
  const paths = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(NIX_STORE_PREFIX));
  const last = paths.at(-1);
  if (last === undefined) throw new Error(`no /nix/store path in nix-build output: ${JSON.stringify(stdout)}`);
  return last;
}

/** Return the leading nix hash segment of a canonical `/nix/store/<hash>-<name>` path. */
export function storeHashOf(storePath: string): string {
  if (!storePath.startsWith(NIX_STORE_PREFIX)) throw new Error(`not a /nix/store path: ${storePath}`);

  const storeName = storePath.slice(NIX_STORE_PREFIX.length);
  if (storeName.length === 0 || storeName.includes("/")) {
    throw new Error(`not a canonical /nix/store path: ${storePath}`);
  }

  const separator = storeName.indexOf("-");
  if (separator <= 0 || separator === storeName.length - 1) {
    throw new Error(`store path basename lacks <hash>-<name>: ${storePath}`);
  }
  return storeName.slice(0, separator);
}
