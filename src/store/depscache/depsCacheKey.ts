import { createHash, type Hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Detection } from "../../detect/index.js";
import { packageManagerDescriptor } from "../../ecosystems/index.js";

const DEPS_CACHE_KEY_VERSION = "2";

/**
 * The deps-cache key for one ecosystem (ADR 0012, dustcastle-8od; dustcastle-8iv.2):
 * a hash of the resolved Toolchain version, Ecosystem, Package Manager, and that
 * ecosystem's LOCKFILE contents. The assembled deps are cached under this key, so a
 * repeat Sandbox on the same inputs restores them instead of re-installing (and
 * re-building native modules). It is keyed on the lockfile CONTENTS plus the dispatch
 * metadata, so a changed lockfile / Toolchain / manager yields a new entry and the old
 * one ages out under GC.
 *
 * A loose / no-lockfile ecosystem (ADR 0006c) has no stable key — its `install`
 * resolves versions afresh, so there is nothing reproducible to key a cache on —
 * therefore this returns `undefined` and that ecosystem always installs in-Sandbox.
 *
 * The lockfile names come from the dispatch grain (the Package Manager descriptor's
 * `lockfiles`, in precedence order); every present lockfile for the selected manager
 * is hashed in that order, so companion lockfiles (for example `go.sum` + `go.mod`)
 * both contribute to the cache key.
 */
export function depsCacheKey(projectDir: string, detection: Detection): string | undefined {
  // A loose manifest has no committed lockfile to pin the install — never cached.
  if (detection.loose === true) return undefined;

  const { lockfiles } = packageManagerDescriptor(detection.packageManager);
  const hash = createHash("sha256");
  hashDetectionInputs(hash, detection);

  let hasLockfile = false;
  for (const lockfileName of lockfiles) {
    const lockfilePath = join(projectDir, lockfileName);
    if (!existsSync(lockfilePath)) continue;
    // Fold the lockfile NAME in too, so two managers' identically-empty lockfiles
    // (unlikely, but possible) never collide on the same key.
    hashField(hash, "lockfile-name", lockfileName);
    hashField(hash, "lockfile-contents", readFileSync(lockfilePath));
    hasLockfile = true;
  }
  // No lockfile on disk ⇒ no stable key (a manifest-only ecosystem the loose flag
  // missed still degrades safely to "not cached").
  if (!hasLockfile) return undefined;
  return hash.digest("hex");
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
