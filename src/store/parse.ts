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
