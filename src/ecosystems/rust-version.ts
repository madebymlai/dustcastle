import type { ToolchainVersionInput } from "./types.js";

/**
 * Read Rust's requested Toolchain channel from rustup's idiomatic version files
 * (dustcastle-gy5.3). `rust-toolchain.toml` wins, then legacy bare
 * `rust-toolchain`. Cargo.toml's `rust-version` is deliberately ignored: it is
 * the MSRV floor, not a concrete Toolchain pin.
 */
export function readRustToolchainVersion({ readVersionFile }: ToolchainVersionInput): string | undefined {
  const tomlChannel = readRustToolchainToml(readVersionFile("rust-toolchain.toml"));
  if (tomlChannel !== undefined) return tomlChannel;

  const legacy = readVersionFile("rust-toolchain")?.trim();
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined;
}

/** Read `[toolchain] channel = "..."` from rust-toolchain.toml. */
export function readRustToolchainToml(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;

  const lines = text.split(/\r?\n/);
  let inToolchain = false;
  for (const line of lines) {
    const stripped = stripComment(line).trim();
    if (stripped.length === 0) continue;
    if (stripped.startsWith("[")) {
      inToolchain = stripped === "[toolchain]";
      continue;
    }
    if (!inToolchain) continue;

    const eq = stripped.indexOf("=");
    if (eq === -1) continue;
    if (stripped.slice(0, eq).trim() !== "channel") continue;
    return unquote(stripped.slice(eq + 1).trim());
  }

  return undefined;
}

/** Drop a trailing `# comment` not inside a quoted string. */
function stripComment(line: string): string {
  let inString: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString !== undefined) {
      if (ch === inString) inString = undefined;
    } else if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Strip matching single or double quotes from a TOML scalar; pass through otherwise. */
function unquote(value: string): string | undefined {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
