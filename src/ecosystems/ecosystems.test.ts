import { describe, expect, it } from "vitest";
import {
  ECOSYSTEMS,
  PACKAGE_MANAGERS,
  ecosystemFor,
  packageManagerDescriptor,
} from "./index.js";

// The Ecosystem Registry (ADR 0001: internal curation, NOT a plugin system) is
// the single, closed set of descriptors the detect/store/impurity/pin/nix sites
// derive from. These tests are a parametrized round-trip over EVERY descriptor:
// they pin the exact strings, importer derivation, gate reasons, and impurity
// signals that today's dispatch sites encode, so the rest of the epic can fold
// onto the Registry without changing behavior.

describe("Ecosystem Registry (ADR 0001 internal curation)", () => {
  it("exposes the closed Ecosystem list, ordered go then node then python", () => {
    expect(ECOSYSTEMS.map((e) => e.ecosystem)).toEqual(["go", "node", "python"]);
  });

  it("curates exactly the eight known Package Managers", () => {
    expect([...PACKAGE_MANAGERS].sort()).toEqual(["bun", "go", "npm", "pip", "pnpm", "poetry", "uv", "yarn"]);
  });

  describe.each(PACKAGE_MANAGERS)("Package Manager descriptor: %s", (pm) => {
    const d = packageManagerDescriptor(pm);

    it("keys on its own closed packageManager name", () => {
      expect(d.packageManager).toBe(pm);
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
      const expected =
        pm === "go"
          ? "vendorHash"
          : pm === "pip" || pm === "uv" || pm === "poetry"
            ? "pythonDepsHash"
            : "npmDepsHash";
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

    it("pip carries a conservative-pure signal over requirements.txt (laimk-hse.4)", () => {
      // pip consumes requirements.txt directly, which has no in-file wheel-vs-sdist
      // signal, so the static reader is conservative-pure; --only-binary=:all: keeps
      // it honest at build time. The richer uv.lock/poetry.lock readers live in
      // src/impurity/python.ts and become each manager's signal when uv/poetry land.
      const sig = packageManagerDescriptor("pip").impuritySignal;
      expect(sig?.lockfile).toBe("requirements.txt");
      expect(sig?.needsImpurity("idna==3.7 --hash=sha256:aaa")).toBe(false);
    });

    it("go has no impuritySignal — it builds pure unconditionally", () => {
      // Go has no impure install scripts; a manager with no signal is always pure.
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
      // bun is gated at provision; go's manifests ARE its lockfile (always pinned),
      // so neither needs a loose-manifest resolve.
      expect(packageManagerDescriptor(pm).lockOnlyResolve).toBeUndefined();
    });

    it("pip resolves a loose manifest with `uv pip compile --generate-hashes` (laimk-hse.5)", () => {
      // The loose Python case (unpinned/hash-less requirements.txt, abstract
      // pyproject) is resolved ONCE into a VISIBLE, hash-pinned requirements.txt
      // via the validated spike command (ADR 0006c amendment). uv is a pure export
      // front-end to the pip-FOD, not a separate Importer.
      const r = packageManagerDescriptor("pip").lockOnlyResolve;
      expect(r).toEqual({
        kind: "command",
        command: "uv",
        args: ["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"],
        lockfile: "requirements.txt",
      });
    });
  });

  describe("the Python Ecosystem descriptor (ADR 0006 amendment — pip-FOD)", () => {
    it("registers pip as a python Package Manager (its pip-FOD build is asserted below)", () => {
      const pip = packageManagerDescriptor("pip");
      expect(pip.ecosystem).toBe("python");
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
      // uv > poetry > pip in precedence (uv.lock > poetry.lock > requirements.txt).
      expect(python.managers).toEqual(["uv", "poetry", "pip"]);
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

  describe("the uv Package Manager is an export front-end to the pip-FOD (laimk-hse.6)", () => {
    it("registers uv as a python Package Manager that builds via the pip-FOD (not uv2nix)", () => {
      const uv = packageManagerDescriptor("uv");
      expect(uv.ecosystem).toBe("python");
      // That the build IS the pip-FOD (not a separate importer) is asserted by the
      // "generates the SAME pip-FOD NixBuild as pip" test below.
    });

    it("signals on uv.lock (the real lockfile that beats requirements.txt)", () => {
      expect(packageManagerDescriptor("uv").lockfiles).toEqual(["uv.lock"]);
    });

    it("lands the discovered hash in pythonDepsHash (the same pip-FOD aggregate hash)", () => {
      expect(packageManagerDescriptor("uv").outputHashField).toBe("pythonDepsHash");
    });

    it("has no provisionGate (the pip-FOD is supported)", () => {
      expect(packageManagerDescriptor("uv").provisionGate).toBeUndefined();
    });

    it("carries the `uv export --format requirements-txt` front-end that feeds the pip-FOD", () => {
      // uv produces the Importer's hash-pinned requirements via `uv export` — carried
      // as descriptor data, NOT a separate Importer (ADR 0006 amendment).
      const front = packageManagerDescriptor("uv").exportFrontEnd;
      expect(front).toEqual({
        command: "uv",
        args: ["export", "--format", "requirements-txt", "-o", "requirements.txt"],
        requirementsFile: "requirements.txt",
      });
    });

    it("reuses the uv.lock impurity reader (laimk-hse.4): sdist-only fires, wheels stay pure", () => {
      const sig = packageManagerDescriptor("uv").impuritySignal;
      expect(sig?.lockfile).toBe("uv.lock");
      // A package with an sdist but no wheels is sdist-only → impure.
      expect(
        sig?.needsImpurity("[[package]]\nname = \"x\"\n\n[package.sdist]\nurl = \"x.tar.gz\"\n"),
      ).toBe(true);
      // A package with wheels stays pure.
      expect(
        sig?.needsImpurity("[[package]]\nname = \"x\"\n\n[[package.wheels]]\nurl = \"x.whl\"\n"),
      ).toBe(false);
    });

    it("generates the SAME pip-FOD NixBuild as pip (uv only changes how requirements are produced)", () => {
      const build = packageManagerDescriptor("uv").generateBuild({
        pname: "sample",
        depsHash: "sha256-AAA=",
        src: "./src",
      });
      expect(build.attrs).toEqual({ toolchain: "python", deps: "deps", app: "app" });
      expect(build.expression).toContain("pip download");
      expect(build.expression).toContain("--only-binary=:all:");
      expect(build.expression).toContain('outputHash = "sha256-AAA="');
    });
  });

  describe("the poetry Package Manager is an export front-end to the pip-FOD (laimk-hse.7)", () => {
    it("registers poetry as a python Package Manager that builds via the pip-FOD (not poetry2nix)", () => {
      const poetry = packageManagerDescriptor("poetry");
      expect(poetry.ecosystem).toBe("python");
      // The pip-FOD build (not poetry2nix) is asserted by the "generates the SAME
      // pip-FOD NixBuild as pip" test below.
    });

    it("signals on poetry.lock", () => {
      expect(packageManagerDescriptor("poetry").lockfiles).toEqual(["poetry.lock"]);
    });

    it("lands the discovered hash in pythonDepsHash (the same pip-FOD aggregate hash)", () => {
      expect(packageManagerDescriptor("poetry").outputHashField).toBe("pythonDepsHash");
    });

    it("carries the `poetry export` front-end that feeds the pip-FOD", () => {
      // poetry produces the Importer's hash-pinned requirements via `poetry export`
      // — carried as descriptor data, NOT a separate Importer / poetry2nix.
      const front = packageManagerDescriptor("poetry").exportFrontEnd;
      expect(front).toEqual({
        command: "poetry",
        // Hashes are ON by default; no `--without-hashes` flag (it is a boolean
        // opt-out, and poetry-plugin-export 1.10 rejects the `=false` value form
        // the laimk-hse.7 spike caught).
        args: ["export", "--format", "requirements.txt", "-o", "requirements.txt"],
        requirementsFile: "requirements.txt",
      });
    });

    it("has no provisionGate (the laimk-hse.7 spike proved poetry export hermetic, like uv)", () => {
      // The spike validated `poetry export` end-to-end through the pip-FOD (pure,
      // offline, same aggregate hash as `uv export`), so the honest bun-gate the
      // unproven front-end once warranted (ADR 0001) is dropped — poetry now
      // provisions through the same pure path as uv/pip.
      expect(packageManagerDescriptor("poetry").provisionGate).toBeUndefined();
    });

    it("reuses the poetry.lock impurity reader (laimk-hse.4): sdist-only fires, wheels stay pure", () => {
      const sig = packageManagerDescriptor("poetry").impuritySignal;
      expect(sig?.lockfile).toBe("poetry.lock");
      // A package whose files section lists only an sdist (no wheel) is impure.
      expect(
        sig?.needsImpurity('[[package]]\nname = "x"\n\n[package.files]\n"x-1.0.tar.gz" = "sha256:aaa"\n'),
      ).toBe(true);
      // A package with a wheel stays pure.
      expect(
        sig?.needsImpurity('[[package]]\nname = "x"\n\n[package.files]\n"x-1.0-py3-none-any.whl" = "sha256:bbb"\n'),
      ).toBe(false);
    });

    it("generates the SAME pip-FOD NixBuild as pip (poetry only changes how requirements are produced)", () => {
      const build = packageManagerDescriptor("poetry").generateBuild({
        pname: "sample",
        depsHash: "sha256-AAA=",
        src: "./src",
      });
      expect(build.attrs).toEqual({ toolchain: "python", deps: "deps", app: "app" });
      expect(build.expression).toContain("pip download");
      expect(build.expression).toContain("--only-binary=:all:");
      expect(build.expression).toContain('outputHash = "sha256-AAA="');
    });
  });

  describe("the Python Ecosystem orders uv > poetry > pip (lockfile precedence, ADR 0006d)", () => {
    it("registers all three managers in lockfile-precedence order", () => {
      const python = ecosystemFor("python");
      expect(python.managers).toEqual(["uv", "poetry", "pip"]);
      // The ordered managers' lockfiles ARE the precedence: uv.lock > poetry.lock >
      // requirements.txt — a richer lockfile beats the looser one (ADR 0006d).
      const lockfilesInOrder = python.managers.flatMap((pm) => packageManagerDescriptor(pm).lockfiles);
      expect(lockfilesInOrder).toEqual(["uv.lock", "poetry.lock", "requirements.txt"]);
    });

    it("keeps pip as the defaultManager (the fallback when no lockfile pins one)", () => {
      expect(ecosystemFor("python").defaultManager).toBe("pip");
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
