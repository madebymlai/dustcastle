/**
 * Extract the correct hash from a Nix fixed-output-derivation hash-mismatch
 * error (ADR 0004). Nix reports the actual content hash on a `got:` line; the
 * store uses it to pin the vendor FOD on the second build. Returns undefined
 * when the output is not a hash mismatch.
 */
export function parseVendorHashMismatch(output: string): string | undefined {
  const match = output.match(/got:\s*(sha256-[A-Za-z0-9+/=]+)/);
  return match?.[1];
}

/**
 * Read the realized store path from `nix-build --no-out-link` stdout. With a
 * single `-A` attribute that's just the path; we take the last `/nix/store/…`
 * line to be robust to leading warnings. Throws if none is present.
 */
export function parseStorePath(stdout: string): string {
  const paths = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/nix/store/"));
  const last = paths.at(-1);
  if (last === undefined) throw new Error(`no /nix/store path in nix-build output: ${JSON.stringify(stdout)}`);
  return last;
}
