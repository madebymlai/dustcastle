import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detect } from "./index.js";

// Each test points detection at a real throwaway directory, so we exercise the
// actual file-reading path — detection is "a thin router over the repo's files"
// (ADR 0006), and these tests describe what it concludes about a repo.

const tmps: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-detect-"));
  tmps.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("detect (ADR 0006 lockfile→importer router)", () => {
  it("routes a Go repo (go.mod + go.sum) to the buildGoModule importer", () => {
    const dir = repo({
      "go.mod": "module example.com/sample\n\ngo 1.26\n",
      "go.sum": "rsc.io/quote v1.5.2 h1:abc=\n",
      "hello.go": "package sample\n",
    });

    const detected = detect(dir);

    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({
      ecosystem: "go",
      packageManager: "go",
    });
  });

  it("reads the toolchain version from go.mod's `go` line (ADR 0006b)", () => {
    const dir = repo({
      "go.mod": "module example.com/sample\n\ngo 1.26.3\n",
      "go.sum": "",
    });

    expect(detect(dir)[0]).toMatchObject({ toolchainVersion: "1.26.3" });
  });

  it("leaves toolchain version undefined when go.mod has no `go` line", () => {
    const dir = repo({ "go.mod": "module example.com/sample\n", "go.sum": "" });

    expect(detect(dir)[0]?.toolchainVersion).toBeUndefined();
  });

  it("detects no ecosystem in a directory with no recognized signals", () => {
    const dir = repo({ "README.md": "# nothing to provision\n" });

    expect(detect(dir)).toEqual([]);
  });
});

describe("detect — JS/Node ecosystem (ADR 0006 slice 2)", () => {
  it("routes an npm repo (package-lock.json) to the npm manager", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
      "package-lock.json": JSON.stringify({ name: "app", lockfileVersion: 3 }),
    });

    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "node",
      packageManager: "npm",
    });
  });

  it("routes a pnpm repo (pnpm-lock.yaml) to the pnpm manager", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "pnpm" });
  });

  it("routes a yarn repo (yarn.lock) to the yarn manager", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "yarn.lock": "# yarn lockfile v1\n",
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "yarn" });
  });

  it("routes a bun repo (bun.lock) to the bun manager", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "bun.lock": "{}\n",
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "bun" });
  });

  it("prefers bun/pnpm/yarn over npm when several lockfiles coexist (ADR 0006d)", () => {
    // The CNB/Paketo precedence: a richer lockfile beats package-lock.json.
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "package-lock.json": JSON.stringify({ name: "app" }),
    });

    expect(detect(dir)[0]?.packageManager).toBe("pnpm");
  });

  it("lets an explicit `packageManager` field beat the lockfile (explicit > inferred)", () => {
    // ADR 0006d: a declared signal wins over an inferred one.
    const dir = repo({
      "package.json": JSON.stringify({ name: "app", packageManager: "yarn@4.1.0" }),
      "package-lock.json": JSON.stringify({ name: "app" }),
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "yarn" });
  });

  it("reads the Node toolchain version from .nvmrc (ADR 0006b), stripping a leading v", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "package-lock.json": "{}",
      ".nvmrc": "v22.11.0\n",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("22.11.0");
  });

  it("falls back to .node-version when there is no .nvmrc", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "package-lock.json": "{}",
      ".node-version": "20.18.1\n",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("20.18.1");
  });

  it("detects Node from a bare package.json (loose manifest, no lockfile)", () => {
    const dir = repo({ "package.json": JSON.stringify({ name: "app" }) });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "node", packageManager: "npm" });
  });

  it("reads the Node toolchain version from package.json#devEngines.runtime (ADR 0006b)", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "app",
        devEngines: { runtime: { name: "node", version: "22.11.0" } },
      }),
      "package-lock.json": "{}",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("22.11.0");
  });

  it("lets devEngines.runtime beat .nvmrc (explicit manifest contract wins)", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "app",
        devEngines: { runtime: { name: "node", version: "22.11.0" } },
      }),
      "package-lock.json": "{}",
      ".nvmrc": "18.0.0\n",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("22.11.0");
  });

  it("handles the array form of devEngines.runtime, picking the node entry", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "app",
        devEngines: { runtime: [{ name: "node", version: "20.18.1" }] },
      }),
      "package-lock.json": "{}",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("20.18.1");
  });

  it("falls back to .nvmrc when devEngines has no node runtime", () => {
    const dir = repo({
      "package.json": JSON.stringify({
        name: "app",
        devEngines: { runtime: { name: "bun", version: "1.0.0" } },
      }),
      "package-lock.json": "{}",
      ".nvmrc": "20.18.1\n",
    });

    expect(detect(dir)[0]?.toolchainVersion).toBe("20.18.1");
  });

  it("flags a lockless package.json as a loose manifest (pin-then-pure, ADR 0006c)", () => {
    // A resolvable-but-unpinned manifest: dustcastle resolves it once into a
    // generated lock, then builds pure — strictly better than going impure.
    const dir = repo({ "package.json": JSON.stringify({ name: "app" }) });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "node", loose: true });
  });

  it("does not flag a package.json that already has a lockfile as loose", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "package-lock.json": "{}",
    });

    expect(detect(dir)[0]?.loose).toBeUndefined();
  });

  it("detects both ecosystems in a polyglot repo (per-directory, ADR 0006d)", () => {
    const dir = repo({
      "go.mod": "module example.com/app\n\ngo 1.26\n",
      "package.json": JSON.stringify({ name: "app" }),
      "package-lock.json": "{}",
    });

    const ecos = detect(dir).map((d) => d.ecosystem);
    expect(ecos).toContain("go");
    expect(ecos).toContain("node");
  });
});

describe("detect — Rust ecosystem (Cargo, dustcastle-gy5.2)", () => {
  it("routes a committed Cargo.lock repo to the cargo manager", () => {
    const dir = repo({
      "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"\nedition = "2021"\n',
      "Cargo.lock": "# generated by cargo\nversion = 4\n",
    });

    expect(detect(dir)).toContainEqual({ ecosystem: "rust", packageManager: "cargo" });
  });
});

describe("detect — Python ecosystem (ADR 0006 amendment, laimk-hse.2)", () => {
  // A hash-pinned, wheels-only requirements.txt (the tracer case): already
  // lock-grade, so it routes the pip-FOD Importer and is NOT a loose manifest.
  const PINNED_REQUIREMENTS =
    "idna==3.10 \\\n" +
    "    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3\n" +
    "urllib3==2.2.3 \\\n" +
    "    --hash=sha256:ca899ca043dcb1bafa3e262d73aa25c465bfb49e0bd9dd5d59f1d0acba2f8fac\n";

  it("routes a hash-pinned requirements.txt to the pip manager", () => {
    const dir = repo({ "requirements.txt": PINNED_REQUIREMENTS });

    expect(detect(dir)).toHaveLength(1);
    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "python",
      packageManager: "pip",
    });
  });

  it("does NOT flag a pinned requirements.txt as loose (it is pip's lockfile)", () => {
    // requirements.txt is BOTH the Python manifest marker AND pip's lockfile, so a
    // present requirements.txt implies a present lockfile — never loose here.
    const dir = repo({ "requirements.txt": PINNED_REQUIREMENTS });

    expect(detect(dir)[0]?.loose).toBeUndefined();
  });

  it("detects Python from a pyproject.toml manifest marker", () => {
    const dir = repo({
      "pyproject.toml": "[project]\nname = \"app\"\n",
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", packageManager: "pip" });
  });

  it("provisions against the .python-version interpreter (laimk-hse.3, ADR 0006b)", () => {
    // A repo declaring 3.11 (patch dropped) provisions against that interpreter —
    // the resolver maps it to the nixpkgs attr the Importer stages.
    const dir = repo({
      "requirements.txt": PINNED_REQUIREMENTS,
      ".python-version": "3.11.9\n",
    });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", toolchainVersion: "python311" });
  });

  it("resolves the highest satisfying minor from pyproject requires-python (laimk-hse.3)", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\nrequires-python = ">=3.10,<3.12"\n',
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", toolchainVersion: "python311" });
  });

  it("surfaces Python alongside Node in a polyglot repo (per-directory, ADR 0006d)", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "package-lock.json": "{}",
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    const ecos = detect(dir).map((d) => d.ecosystem);
    expect(ecos).toContain("node");
    expect(ecos).toContain("python");
  });

  // Loose-manifest pin-then-pure (ADR 0006c, laimk-hse.5). Unlike Node, where
  // requirements-presence implies a lockfile, a Python requirements.txt is the
  // pip-FOD's lockfile ONLY when it is lock-grade (== + --hash). A loose one is
  // flagged `loose` so dustcastle resolves it ONCE (uv pip compile) then builds pure.
  it("flags an UNPINNED requirements.txt as loose (pin-then-pure, ADR 0006c)", () => {
    const dir = repo({ "requirements.txt": "idna\nurllib3\n" });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", packageManager: "pip", loose: true });
  });

  it("flags a hash-LESS pinned requirements.txt as loose (the pip-FOD needs hashes)", () => {
    const dir = repo({ "requirements.txt": "idna==3.10\nurllib3==2.2.3\n" });

    expect(detect(dir)[0]?.loose).toBe(true);
  });

  it("flags an ABSTRACT pyproject.toml (no lock, no requirements.txt) as loose", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna", "urllib3"]\n',
    });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", loose: true });
  });

  it("does NOT flag a lock-grade requirements.txt as loose even with an abstract pyproject", () => {
    // pyproject is abstract, but the hash-pinned requirements.txt IS the lockfile,
    // so the build runs pure directly — no resolve needed.
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna"]\n',
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    expect(detect(dir)[0]?.loose).toBeUndefined();
  });

  // uv Package Manager (laimk-hse.6). `uv.lock` is a real lockfile that beats a
  // co-present requirements.txt (ADR 0006d: "a repo with both uv.lock and
  // requirements.txt uses uv"). uv is an EXPORT FRONT-END to the same pip-FOD —
  // `uv export --format requirements-txt` produces the hash-pinned requirements,
  // so the importer is still pip-FOD (not uv2nix), per the ADR 0006 amendment.
  it("routes a uv.lock repo to uv (the pip-FOD Importer via the uv export front-end)", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna"]\n',
      "uv.lock": "version = 1\n\n[[package]]\nname = \"idna\"\nversion = \"3.10\"\n",
    });

    expect(detect(dir)).toHaveLength(1);
    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "python",
      packageManager: "uv",
    });
  });

  it("uv.lock beats a co-present requirements.txt (a repo with both uses uv, ADR 0006d)", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna"]\n',
      "uv.lock": "version = 1\n\n[[package]]\nname = \"idna\"\nversion = \"3.10\"\n",
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    // The richer lockfile wins: precedence is uv.lock > requirements.txt.
    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", packageManager: "uv" });
  });

  // poetry Package Manager (laimk-hse.7). `poetry.lock` is a real lockfile that
  // beats a co-present requirements.txt but loses to uv.lock (ADR 0006d precedence:
  // uv.lock > poetry.lock > requirements.txt). poetry is an EXPORT FRONT-END
  // (`poetry export`) to the same pip-FOD — not poetry2nix — so the importer is
  // still pip-FOD per the ADR 0006 amendment.
  it("routes a poetry.lock repo to poetry (the pip-FOD Importer via the poetry export front-end)", () => {
    const dir = repo({
      "pyproject.toml": '[tool.poetry]\nname = "app"\n\n[tool.poetry.dependencies]\nidna = "3.10"\n',
      "poetry.lock": '[[package]]\nname = "idna"\nversion = "3.10"\n',
    });

    expect(detect(dir)).toHaveLength(1);
    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "python",
      packageManager: "poetry",
    });
  });

  it("poetry.lock beats a co-present requirements.txt (poetry > requirements.txt, ADR 0006d)", () => {
    const dir = repo({
      "pyproject.toml": '[tool.poetry]\nname = "app"\n',
      "poetry.lock": '[[package]]\nname = "idna"\nversion = "3.10"\n',
      "requirements.txt": PINNED_REQUIREMENTS,
    });

    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", packageManager: "poetry" });
  });

  it("uv.lock beats a co-present poetry.lock (uv > poetry, ADR 0006d)", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna"]\n',
      "uv.lock": 'version = 1\n\n[[package]]\nname = "idna"\nversion = "3.10"\n',
      "poetry.lock": '[[package]]\nname = "idna"\nversion = "3.10"\n',
    });

    // The richer lockfile wins: precedence is uv.lock > poetry.lock.
    expect(detect(dir)[0]).toMatchObject({ ecosystem: "python", packageManager: "uv" });
  });

  // A richer lockfile with NO committed requirements.txt is NOT loose (laimk-hse.7):
  // the export front-end materialises requirements.txt at provision time, so the
  // project is lock-pinned. (Before the fix, the requirements.txt-only loose reader
  // wrongly flagged every such repo loose — the common real-world uv/poetry shape.)
  it("does NOT flag a uv.lock repo (no requirements.txt) as loose — uv.lock is the lock", () => {
    const dir = repo({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["idna"]\n',
      "uv.lock": 'version = 1\n\n[[package]]\nname = "idna"\nversion = "3.10"\n',
    });

    expect(detect(dir)[0]?.loose).toBeUndefined();
  });

  it("does NOT flag a poetry.lock repo (no requirements.txt) as loose — poetry.lock is the lock", () => {
    const dir = repo({
      "pyproject.toml": '[tool.poetry]\nname = "app"\n',
      "poetry.lock": '[[package]]\nname = "idna"\nversion = "3.10"\n',
    });

    expect(detect(dir)[0]?.loose).toBeUndefined();
  });
});
