import { describe, expect, it } from "vitest";
import {
  poetryLockNeedsImpurity,
  requirementsNeedsImpurity,
  uvLockNeedsImpurity,
} from "./python.js";

// The Python impurity signal (ADR 0004 + ADR 0006 amendment). The pip-FOD builds
// pure with `--only-binary=:all:` — wheels run no install-time code, so assembly
// is pure by construction. A package is impure exactly when no compatible WHEEL
// exists for the target: a `uv.lock`/`poetry.lock` package that ships only an
// sdist (.tar.gz / .zip) and no `.whl` would have to be BUILT from source during
// download, which `--only-binary=:all:` forbids — so it routes to the existing
// impure container path (allow/ask/deny) rather than failing silently.
//
// `requirements.txt` carries no in-file wheel-vs-sdist signal, so it is
// CONSERVATIVE: always pure. `--only-binary=:all:` keeps that honest at build
// time (an sdist-only dep hard-fails the download and surfaces, never builds).

describe("uvLockNeedsImpurity (uv.lock wheel-vs-sdist; sdist-only ⇒ impure)", () => {
  // uv.lock is TOML: each [[package]] may carry a [package.sdist] table and/or a
  // [[package.wheels]] array. A package with at least one wheel builds pure; a
  // package with an sdist and NO wheels must be built from source ⇒ impure.
  const wheelPkg = [
    "[[package]]",
    'name = "idna"',
    'version = "3.7"',
    "",
    "[package.sdist]",
    'url = "https://files.pythonhosted.org/idna-3.7.tar.gz"',
    'hash = "sha256:aaa"',
    "",
    "[[package.wheels]]",
    'url = "https://files.pythonhosted.org/idna-3.7-py3-none-any.whl"',
    'hash = "sha256:bbb"',
  ].join("\n");

  const sdistOnlyPkg = [
    "[[package]]",
    'name = "legacy-thing"',
    'version = "1.0"',
    "",
    "[package.sdist]",
    'url = "https://files.pythonhosted.org/legacy-thing-1.0.tar.gz"',
    'hash = "sha256:ccc"',
  ].join("\n");

  it("is pure when every package ships at least one wheel (the common path)", () => {
    expect(uvLockNeedsImpurity(wheelPkg)).toBe(false);
  });

  it("flags impurity when a package has an sdist but no wheel (must build from source)", () => {
    expect(uvLockNeedsImpurity([wheelPkg, "", sdistOnlyPkg].join("\n"))).toBe(true);
  });

  it("is pure when a package has neither sdist nor wheels (a local/virtual root — nothing to build)", () => {
    const rootOnly = ["[[package]]", 'name = "myapp"', 'version = "0.1.0"', 'source = { virtual = "." }'].join("\n");
    expect(uvLockNeedsImpurity(rootOnly)).toBe(false);
  });

  it("is conservative-pure for empty / undefined input (nothing to build)", () => {
    expect(uvLockNeedsImpurity("")).toBe(false);
    expect(uvLockNeedsImpurity(undefined)).toBe(false);
  });
});

describe("poetryLockNeedsImpurity (poetry.lock files list; sdist-only ⇒ impure)", () => {
  // poetry.lock is TOML: each [[package]] has a [package.files] section listing
  // every artifact by filename. A package whose files are ALL sdists (.tar.gz /
  // .zip) with no .whl must be built from source ⇒ impure.
  const wheelPkg = [
    "[[package]]",
    'name = "urllib3"',
    'version = "2.2.1"',
    'description = "HTTP library"',
    "",
    "[package.files]",
    'urllib3-2.2.1-py3-none-any.whl = "sha256:aaa"',
    'urllib3-2.2.1.tar.gz = "sha256:bbb"',
  ].join("\n");

  const sdistOnlyPkg = [
    "[[package]]",
    'name = "legacy-thing"',
    'version = "1.0"',
    'description = "old"',
    "",
    "[package.files]",
    'legacy-thing-1.0.tar.gz = "sha256:ccc"',
  ].join("\n");

  it("is pure when a package ships a wheel alongside its sdist (the common path)", () => {
    expect(poetryLockNeedsImpurity(wheelPkg)).toBe(false);
  });

  it("flags impurity when a package's files are all sdists (.tar.gz / .zip)", () => {
    expect(poetryLockNeedsImpurity([wheelPkg, "", sdistOnlyPkg].join("\n"))).toBe(true);
  });

  it("flags impurity for a .zip-only sdist package", () => {
    const zipOnly = [
      "[[package]]",
      'name = "zipdist"',
      'version = "2.0"',
      "",
      "[package.files]",
      'zipdist-2.0.zip = "sha256:ddd"',
    ].join("\n");
    expect(poetryLockNeedsImpurity(zipOnly)).toBe(true);
  });

  it("is pure when a package carries no files section (nothing to build)", () => {
    const noFiles = ["[[package]]", 'name = "myapp"', 'version = "0.1.0"'].join("\n");
    expect(poetryLockNeedsImpurity(noFiles)).toBe(false);
  });

  it("is conservative-pure for empty / undefined input", () => {
    expect(poetryLockNeedsImpurity("")).toBe(false);
    expect(poetryLockNeedsImpurity(undefined)).toBe(false);
  });

  // Real poetry (2.x, lock-version 2.1) emits an inline `files = [{file = "…"}, …]`
  // ARRAY rather than a `[package.files]` sub-table — the form the laimk-hse.7 spike
  // exercised against poetry 2.4.1. The old table-only scan missed it (every real
  // lock read as pure); these lock the array form in.
  describe("real poetry 2.x inline `files = [...]` array form (lock-version 2.1)", () => {
    const wheelArrayPkg = [
      "[[package]]",
      'name = "urllib3"',
      'version = "2.7.0"',
      'groups = ["main"]',
      "files = [",
      '    {file = "urllib3-2.7.0-py3-none-any.whl", hash = "sha256:aaa"},',
      '    {file = "urllib3-2.7.0.tar.gz", hash = "sha256:bbb"},',
      "]",
    ].join("\n");

    const sdistOnlyArrayPkg = [
      "[[package]]",
      'name = "legacy-thing"',
      'version = "1.0"',
      'groups = ["main"]',
      "files = [",
      '    {file = "legacy-thing-1.0.tar.gz", hash = "sha256:ccc"},',
      "]",
    ].join("\n");

    it("is pure when a package's array lists a wheel alongside its sdist", () => {
      expect(poetryLockNeedsImpurity(wheelArrayPkg)).toBe(false);
    });

    it("flags impurity when a package's array is all sdists (no wheel)", () => {
      expect(poetryLockNeedsImpurity([wheelArrayPkg, "", sdistOnlyArrayPkg].join("\n"))).toBe(true);
    });

    it("does not let an `[package.extras]` sub-table mask the files array", () => {
      const withExtras = [
        wheelArrayPkg,
        "",
        "[package.extras]",
        'socks = ["pysocks (>=1.5.6,!=1.5.7,<2.0)"]',
      ].join("\n");
      expect(poetryLockNeedsImpurity(withExtras)).toBe(false);
    });
  });
});

describe("requirementsNeedsImpurity (no in-file signal ⇒ conservative-pure)", () => {
  // requirements.txt carries no wheel-vs-sdist metadata: the pure FOD's
  // `--only-binary=:all:` enforces honesty at build time (an sdist-only dep
  // hard-fails the download and surfaces). The static signal is always pure.
  it("is always pure regardless of content", () => {
    expect(requirementsNeedsImpurity("idna==3.7 --hash=sha256:aaa")).toBe(false);
    expect(requirementsNeedsImpurity("")).toBe(false);
    expect(requirementsNeedsImpurity(undefined)).toBe(false);
  });
});
