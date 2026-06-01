import type { ToolchainVersionInput } from "./types.js";

const RUST_TOOLCHAIN_TOML = "rust-toolchain.toml";
const LEGACY_RUST_TOOLCHAIN = "rust-toolchain";
const TOOLCHAIN_TABLE = "toolchain";
const CHANNEL_KEY = "channel";

/**
 * Read Rust's requested Toolchain channel from rustup's idiomatic version files.
 * `rust-toolchain.toml` wins, then legacy bare `rust-toolchain`. Cargo.toml's
 * `rust-version` is deliberately ignored: it is the MSRV floor, not a pin.
 */
export function readRustToolchainVersion({ readVersionFile }: ToolchainVersionInput): string | undefined {
  const tomlChannel = readRustToolchainToml(readVersionFile(RUST_TOOLCHAIN_TOML));
  if (tomlChannel !== undefined) return tomlChannel;

  return nonEmpty(readVersionFile(LEGACY_RUST_TOOLCHAIN)?.trim());
}

/** Read `[toolchain] channel = "..."` from rust-toolchain.toml. */
export function readRustToolchainToml(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;

  let inToolchainTable = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = stripTomlComment(line).trim();
    if (trimmedLine.length === 0) continue;

    if (trimmedLine.startsWith("[")) {
      inToolchainTable = parseTomlTableHeader(trimmedLine) === TOOLCHAIN_TABLE;
      continue;
    }
    if (!inToolchainTable) continue;

    const assignment = parseTomlAssignment(trimmedLine);
    if (assignment?.key !== CHANNEL_KEY) continue;
    return readTomlScalar(assignment.value);
  }

  return undefined;
}

function parseTomlTableHeader(line: string): string | undefined {
  if (!line.startsWith("[") || !line.endsWith("]") || line.startsWith("[[")) return undefined;
  return nonEmpty(line.slice(1, -1).trim());
}

function parseTomlAssignment(line: string): { key: string; value: string } | undefined {
  const separator = line.indexOf("=");
  if (separator === -1) return undefined;

  return {
    key: line.slice(0, separator).trim(),
    value: line.slice(separator + 1).trim(),
  };
}

/** Drop a trailing `# comment` not inside a quoted string. */
function stripTomlComment(line: string): string {
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
function readTomlScalar(value: string): string | undefined {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }

  return nonEmpty(value.trim());
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
