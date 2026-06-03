import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The running dustcastle version, read once from the shipped package.json. npm
 * always includes package.json in the published tarball, and it sits one dir above
 * this module in both the built CLI (dist/version.js → ../package.json) and under
 * tsx/vitest (src/version.ts → ../package.json), so the same relative resolve works
 * in both. Memoised: the file is read at most once per process.
 *
 * Used to make the dustcastle-owned image tags content-busting (see image.ts
 * {@link imageRef}): a release that changes what's baked into an image bumps the
 * version, which changes the tag, which invalidates the cached image.
 */
let cached: string | undefined;

export function dustcastleVersion(): string {
  if (cached === undefined) {
    const text = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const pkg: unknown = JSON.parse(text);
    cached = typeof pkg === "object" && pkg !== null && typeof (pkg as { version?: unknown }).version === "string"
      ? (pkg as { version: string }).version
      : "0.0.0";
  }
  return cached;
}
