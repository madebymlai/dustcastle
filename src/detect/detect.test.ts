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
      importer: "buildGoModule",
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
  it("routes an npm repo (package-lock.json) to the fetchNpmDeps importer", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
      "package-lock.json": JSON.stringify({ name: "app", lockfileVersion: 3 }),
    });

    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "node",
      packageManager: "npm",
      importer: "fetchNpmDeps",
    });
  });

  it("routes a pnpm repo (pnpm-lock.yaml) to the fetchPnpmDeps importer", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "pnpm", importer: "fetchPnpmDeps" });
  });

  it("routes a yarn repo (yarn.lock) to the yarn importer", () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "app" }),
      "yarn.lock": "# yarn lockfile v1\n",
    });

    expect(detect(dir)[0]).toMatchObject({ packageManager: "yarn", importer: "fetchYarnDeps" });
  });

  it("routes a bun repo (bun.lock) to the bun importer", () => {
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

    expect(detect(dir)[0]).toMatchObject({ packageManager: "yarn", importer: "fetchYarnDeps" });
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

describe("detect — Python ecosystem (ADR 0006 amendment, laimk-hse.2)", () => {
  // A hash-pinned, wheels-only requirements.txt (the tracer case): already
  // lock-grade, so it routes the pip-FOD Importer and is NOT a loose manifest.
  const PINNED_REQUIREMENTS =
    "idna==3.10 \\\n" +
    "    --hash=sha256:946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3\n" +
    "urllib3==2.2.3 \\\n" +
    "    --hash=sha256:ca899ca043dcb1bafa3e262d73aa25c465bfb49e0bd9dd5d59f1d0acba2f8fac\n";

  it("routes a hash-pinned requirements.txt to the pip-FOD importer", () => {
    const dir = repo({ "requirements.txt": PINNED_REQUIREMENTS });

    expect(detect(dir)).toHaveLength(1);
    expect(detect(dir)[0]).toMatchObject({
      ecosystem: "python",
      packageManager: "pip",
      importer: "pip-FOD",
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
});
