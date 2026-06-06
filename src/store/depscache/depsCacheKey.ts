import { createHash, type Hash } from "node:crypto";
import type { Detection } from "../../detect/index.js";
import { ecosystemFor, packageManagerDescriptor } from "../../ecosystems/index.js";
import { readGitHeadAuthoredSource, type AuthoredSourceReader } from "./authoredSource.js";

const DEPS_CACHE_KEY_VERSION = "4";

/**
 * The deps-cache key for one ecosystem (ADR 0016): a project deps fingerprint over
 * the resolved Toolchain version, Ecosystem, Package Manager, and every dependency-
 * determining file present for that Ecosystem (`manifests ∪ lockfiles`, de-duplicated
 * in declared order). The `loose` detection flag is informational only: lockless repos
 * still get a stable fingerprint over their manifests and are cacheable.
 */
export function depsCacheKey(
  projectDir: string,
  detection: Detection,
  readAuthoredSource: AuthoredSourceReader = readGitHeadAuthoredSource,
): string {
  const hash = createHash("sha256");
  hashDetectionInputs(hash, detection);

  for (const fileName of depsInputFiles(detection)) {
    hashDepsInputFile(hash, projectDir, fileName, readAuthoredSource);
  }

  return hash.digest("hex");
}

function depsInputFiles(detection: Detection): string[] {
  const ecosystem = ecosystemFor(detection.ecosystem);
  const manager = packageManagerDescriptor(detection.packageManager);
  return uniqueInOrder([...ecosystem.manifests, ...manager.lockfiles]);
}

function uniqueInOrder(values: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function hashDepsInputFile(
  hash: Hash,
  projectDir: string,
  fileName: string,
  readAuthoredSource: AuthoredSourceReader,
): void {
  const content = readAuthoredSource(projectDir, fileName);
  if (content === undefined) return;

  hashField(hash, "deps-file-name", fileName);
  hashField(hash, "deps-file-contents", content);
}

function hashDetectionInputs(hash: Hash, detection: Detection): void {
  hashField(hash, "key-version", DEPS_CACHE_KEY_VERSION);
  hashField(hash, "ecosystem", detection.ecosystem);
  hashField(hash, "package-manager", detection.packageManager);
  hashField(hash, "toolchain-version", detection.toolchainVersion ?? "");
}

function hashField(hash: Hash, name: string, value: string | Buffer): void {
  hash.update(name);
  hash.update("\0");
  hash.update(String(value.length));
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}
