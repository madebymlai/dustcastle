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
};

describe("Ecosystem Registry (ADR 0001 internal curation)", () => {
  it("exposes the closed Ecosystem list, ordered go then node", () => {
    expect(ECOSYSTEMS.map((e) => e.ecosystem)).toEqual(["go", "node"]);
  });

  it("curates exactly the five known Package Managers", () => {
    expect([...PACKAGE_MANAGERS].sort()).toEqual(["bun", "go", "npm", "pnpm", "yarn"]);
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
      const expected = pm === "go" ? "vendorHash" : "npmDepsHash";
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

    it("go has no impuritySignal (only Node has impure install scripts)", () => {
      expect(packageManagerDescriptor("go").impuritySignal).toBeUndefined();
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

    it.each(["bun", "go"] as const)("%s has no lockOnlyResolve", (pm) => {
      expect(packageManagerDescriptor(pm).lockOnlyResolve).toBeUndefined();
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
  });
});
