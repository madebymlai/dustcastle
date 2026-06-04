import { createHash, type Hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Detection } from "../../detect/index.js";
import { ecosystemFor, packageManagerDescriptor } from "../../ecosystems/index.js";

const DEPS_CACHE_KEY_VERSION = "3";

/**
 * The deps-cache key for one ecosystem (ADR 0016): a project deps fingerprint over
 * the resolved Toolchain version, Ecosystem, Package Manager, and every dependency-
 * determining file present for that Ecosystem (`manifests ∪ lockfiles`, de-duplicated
 * in declared order). The `loose` detection flag is informational only: lockless repos
 * still get a stable fingerprint over their manifests and are cacheable.
 */
export function depsCacheKey(projectDir: string, detection: Detection): string {
  const hash = createHash("sha256");
  hashDetectionInputs(hash, detection);

  for (const fileName of depsInputFiles(detection)) {
    const filePath = join(projectDir, fileName);
    if (!existsSync(filePath)) continue;
    hashField(hash, "deps-file-contents", readFileSync(filePath));
  }

  return hash.digest("hex");
}

function depsInputFiles(detection: Detection): string[] {
  const ecosystem = ecosystemFor(detection.ecosystem);
  const manager = packageManagerDescriptor(detection.packageManager);
  const files: string[] = [];
  const seen = new Set<string>();
  for (const file of [...ecosystem.manifests, ...manager.lockfiles]) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
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
