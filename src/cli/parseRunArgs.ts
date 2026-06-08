/**
 * Parse `dustcastle run` arguments to extract the optional --dustless / -d flag.
 * Recognized only within the `run` command — not a global-position flag.
 */
export interface ParsedRunArgs {
  readonly dustless: boolean;
}

export function parseRunArgs(argv: readonly string[]): ParsedRunArgs {
  const dustless = argv.includes("--dustless") || argv.includes("-d");
  return { dustless };
}
