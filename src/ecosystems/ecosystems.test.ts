import { describe, expect, it } from "vitest";
import {
  ECOSYSTEMS,
  PACKAGE_MANAGERS,
  ecosystemFor,
  packageManagerDescriptor,
  type Ecosystem,
  type PackageManager,
} from "./index.js";

// The Ecosystem Registry (ADR 0001: internal curation, NOT a plugin system) is
// the single, closed set of descriptors the detect/store/impurity/pin/nix sites
// derive from. These tests are a parametrized round-trip over EVERY descriptor:
// they pin the exact strings, importer derivation, gate reasons, and impurity
// signals that today's dispatch sites encode, so the rest of the epic can fold
// onto the Registry without changing behavior.

// The importer each Package Manager derives 1:1 (ADR 0006a; CONTEXT.md: Importer
// is a *property of* the Package Manager, not a second key). The store dispatches
// on these exact attr names today, so the Registry must reproduce them exactly.
const EXPECTED_IMPORTER: Record<PackageManager, string> = {
  npm: "fetchNpmDeps",
  pnpm: "fetchPnpmDeps",
  yarn: "fetchYarnDeps",
  bun: "fetchBunDeps",
  go: "buildGoModule",
  pip: "pip-FOD",
};

describe("Ecosystem Registry (ADR 0001 internal curation)", () => {
  it("exposes the closed Ecosystem list, ordered go then node then python", () => {
    expect(ECOSYSTEMS.map((e) => e.ecosystem)).toEqual(["go", "node", "python"]);
  });

  it("curates exactly the six known Package Managers", () => {
    expect([...PACKAGE_MANAGERS].sort()).toEqual(["bun", "go", "npm", "pip", "pnpm", "yarn"]);
  });

  describe.each(PACKAGE_MANAGERS)("Package Manager descriptor: %s", (pm) => {
    const d = packageManagerDescriptor(pm);

    it("keys on its own closed packageManager name", () => {
      expect(d.packageManager).toBe(pm);
    });

    it("derives the importer 1:1 (ADR 0006a)", () => {
      expect(d.importer).toBe(EXPECTED_IMPORTER[pm]);
    });

    it("declares at least one lockfile", () => {
      expect(d.lockfiles.length).toBeGreaterThan(0);
    });

    it("generates a NixBuild whose attrs the store realizes", () => {
      const build = d.generateBuild({ pname: "sample", depsHash: "sha256-AAA=", src: "./src" });
      expect(build.attrs.toolchain.length).toBeGreaterThan(0);
      expect(build.attrs.deps).toBe("deps");
      expect(build.attrs.app).toBe("app");
      expect(build.expression).toContain('pname = "sample');
    });

    it("marks which Provisioned field carries the discovered hash", () => {
      const expected = pm === "go" ? "vendorHash" : pm === "pip" ? "pythonDepsHash" : "npmDepsHash";
      expect(d.outputHashField).toBe(expected);
    });
  });

  describe("importer derivation reproduces today's JS_IMPORTERS map exactly", () => {
    it.each(["npm", "pnpm", "yarn", "bun"] as const)("%s", (pm) => {
      const build = packageManagerDescriptor(pm).generateBuild({ pname: "p", depsHash: "sha256-AAA=" });
      // The toolchain attr is the contract the store stages: nodejs for JS, go for Go.
      expect(build.attrs.toolchain).toBe("nodejs");
    });

    it("go realizes the go toolchain attr", () => {
      const build = packageManagerDescriptor("go").generateBuild({ pname: "p", depsHash: "sha256-AAA=" });
      expect(build.attrs.toolchain).toBe("go");
    });
  });

  describe("the bun gate is a first-class honest state (ADR 0001), not an ad-hoc throw", () => {
    it("bun carries a provisionGate with its actionable no-canonical-importer reason", () => {
      const gate = packageManagerDescriptor("bun").provisionGate;
      expect(gate).toBeDefined();
      expect(gate?.reason).toMatch(/bun/i);
      expect(gate?.reason).toMatch(/no canonical|not yet supported/i);
    });

    it.each(["npm", "pnpm", "yarn", "go"] as const)("%s has no provisionGate", (pm) => {
      expect(packageManagerDescriptor(pm).provisionGate).toBeUndefined();
    });
  });

  describe("the impurity signal reads straight from the lockfile (ADR 0004)", () => {
    it("npm fires when the lockfile records hasInstallScript", () => {
      const sig = packageManagerDescriptor("npm").impuritySignal;
      expect(sig?.lockfile).toBe("package-lock.json");
      expect(sig?.needsImpurity(JSON.stringify({ packages: { "node_modules/x": { hasInstallScript: true } } }))).toBe(
        true,
      );
      expect(sig?.needsImpurity(JSON.stringify({ packages: { "node_modules/x": {} } }))).toBe(false);
    });

    it("pnpm fires when the lockfile records requiresBuild: true", () => {
      const sig = packageManagerDescriptor("pnpm").impuritySignal;
      expect(sig?.lockfile).toBe("pnpm-lock.yaml");
      expect(sig?.needsImpurity("  x:\n    requiresBuild: true\n")).toBe(true);
      expect(sig?.needsImpurity("  x:\n    resolution: {}\n")).toBe(false);
    });

    it.each(["yarn", "bun"] as const)("%s carries a present-but-always-false signal (settled by design)", (pm) => {
      const sig = packageManagerDescriptor(pm).impuritySignal;
      expect(sig).toBeDefined();
      // The signal exists (it has a lockfile name) but the lockfile cannot carry a
      // script flag, so it always reads false — honest, not a gap.
      expect(sig?.needsImpurity("anything")).toBe(false);
    });

    it.each(["go", "pip"] as const)("%s has no impuritySignal in this slice", (pm) => {
      // Only Node has impure install scripts in v1; Python's sdist-only routing is
      // a later slice (laimk-hse.4), so pip carries no impuritySignal yet.
      expect(packageManagerDescriptor(pm).impuritySignal).toBeUndefined();
    });
  });

  describe("pin-then-pure lockOnlyResolve state (ADR 0006c)", () => {
    it("npm resolves to a package-lock-only command", () => {
      const r = packageManagerDescriptor("npm").lockOnlyResolve;
      expect(r).toEqual({
        kind: "command",
        command: "npm",
        args: ["install", "--package-lock-only"],
        lockfile: "package-lock.json",
      });
    });

    it("pnpm resolves to a lockfile-only command", () => {
      const r = packageManagerDescriptor("pnpm").lockOnlyResolve;
      expect(r).toEqual({
        kind: "command",
        command: "pnpm",
        args: ["install", "--lockfile-only"],
        lockfile: "pnpm-lock.yaml",
      });
    });

    it("yarn is a gated state carrying its actionable reason (no clean lockfile-only resolve)", () => {
      const r = packageManagerDescriptor("yarn").lockOnlyResolve;
      expect(r?.kind).toBe("gated");
      if (r?.kind === "gated") expect(r.reason).toMatch(/yarn/i);
    });

    it.each(["bun", "go", "pip"] as const)("%s has no lockOnlyResolve", (pm) => {
      // pip's loose-manifest pin-then-pure (`uv pip compile --generate-hashes`) is
      // a later slice (laimk-hse.5); a hash-pinned requirements.txt is already
      // lock-grade, so this tracer slice carries no lockOnlyResolve for pip.
      expect(packageManagerDescriptor(pm).lockOnlyResolve).toBeUndefined();
    });
  });

  describe("the Python Ecosystem descriptor (ADR 0006 amendment — pip-FOD)", () => {
    it("registers pip as a python Package Manager with the pip-FOD importer", () => {
      const pip = packageManagerDescriptor("pip");
      expect(pip.ecosystem).toBe("python");
      expect(pip.importer).toBe("pip-FOD");
    });

    it("consumes requirements.txt directly (hash-pinned is lock-grade)", () => {
      expect(packageManagerDescriptor("pip").lockfiles).toEqual(["requirements.txt"]);
    });

    it("lands the discovered hash in pythonDepsHash (not npmDepsHash)", () => {
      expect(packageManagerDescriptor("pip").outputHashField).toBe("pythonDepsHash");
    });

    it("pip has no provisionGate (the pip-FOD is supported, unlike bun)", () => {
      expect(packageManagerDescriptor("pip").provisionGate).toBeUndefined();
    });

    it("python's manifest markers are pyproject.toml/requirements.txt/setup.py", () => {
      const python = ecosystemFor("python");
      expect(python.manifests).toEqual(["pyproject.toml", "requirements.txt", "setup.py"]);
      expect(python.managers).toEqual(["pip"]);
      expect(python.defaultManager).toBe("pip");
    });

    it("generates a pip-FOD NixBuild whose attrs the store realizes", () => {
      const build = packageManagerDescriptor("pip").generateBuild({
        pname: "sample",
        depsHash: "sha256-AAA=",
        src: "./src",
      });
      expect(build.attrs).toEqual({ toolchain: "python", deps: "deps", app: "app" });
      // The pip-FOD download step, hash-pinned (ADR 0006 amendment).
      expect(build.expression).toContain("pip download");
      expect(build.expression).toContain("--only-binary=:all:");
      expect(build.expression).toContain('outputHash = "sha256-AAA="');
    });
  });

  describe("Ecosystem descriptors carry the detection grain (ADR 0006)", () => {
    it("node's ordered managers ARE the lockfile precedence (ADR 0006d)", () => {
      const node = ecosystemFor("node");
      // bun.lockb, bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json — richer beats npm.
      const lockfilesInOrder = node.managers.flatMap((pm) => packageManagerDescriptor(pm).lockfiles);
      expect(lockfilesInOrder).toEqual(["bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]);
    });

    it("node's defaultManager is npm and its manifest marker is package.json", () => {
      const node = ecosystemFor("node");
      expect(node.defaultManager).toBe("npm");
      expect(node.manifests).toContain("package.json");
    });

    it("go's manifest markers are go.mod/go.sum and its sole manager is go", () => {
      const go = ecosystemFor("go");
      expect(go.managers).toEqual(["go"]);
      expect(go.defaultManager).toBe("go");
      expect(go.manifests).toEqual(["go.mod", "go.sum"]);
    });

    it("node reads its declared manager from the packageManager field (ADR 0006d explicit > inferred)", () => {
      const node = ecosystemFor("node");
      expect(node.readDeclaredManager?.('{"packageManager":"yarn@4.1.0"}')).toBe("yarn");
      expect(node.readDeclaredManager?.("{}")).toBeUndefined();
    });

    it("node reads the toolchain version from devEngines, then version files", () => {
      const node = ecosystemFor("node");
      // The reader takes the manifest text and version-file lookups; here we only
      // assert it threads the devEngines.runtime contract (ADR 0006b).
      const version = node.readToolchainVersion?.({
        manifest: JSON.stringify({ devEngines: { runtime: { name: "node", version: "22.1.0" } } }),
        readVersionFile: () => undefined,
      });
      expect(version).toBe("22.1.0");
    });

    it("go reads the toolchain version from go.mod's go line", () => {
      const go = ecosystemFor("go");
      const version = go.readToolchainVersion?.({
        manifest: "module example.com/x\n\ngo 1.26\n",
        readVersionFile: () => undefined,
      });
      expect(version).toBe("1.26");
    });

    describe("python resolves its Toolchain interpreter (laimk-hse.3)", () => {
      const python = ecosystemFor("python");

      it("honours an exact .python-version pin (patch dropped) as a nixpkgs attr", () => {
        const attr = python.readToolchainVersion?.({
          manifest: undefined,
          readVersionFile: (name) => (name === ".python-version" ? "3.11.9\n" : undefined),
        });
        expect(attr).toBe("python311");
      });

      it("resolves the highest satisfying stable minor from pyproject requires-python", () => {
        const attr = python.readToolchainVersion?.({
          manifest: '[project]\nrequires-python = ">=3.10,<3.12"\n',
          readVersionFile: () => undefined,
        });
        expect(attr).toBe("python311");
      });

      it("defaults to python3 when neither a version file nor requires-python constrains it", () => {
        const attr = python.readToolchainVersion?.({
          manifest: undefined,
          readVersionFile: () => undefined,
        });
        expect(attr).toBe("python3");
      });

      it("surfaces an actionable error for an EOL/missing pinned minor (no silent fallback)", () => {
        expect(() =>
          python.readToolchainVersion?.({
            manifest: undefined,
            readVersionFile: (name) => (name === ".python-version" ? "3.8" : undefined),
          }),
        ).toThrow(/3\.8/);
      });
    });
  });
});
