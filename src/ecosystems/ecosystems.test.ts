import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "./rust.js";
import {
  ECOSYSTEMS,
  PACKAGE_MANAGERS,
  ecosystemFor,
  packageManagerDescriptor,
} from "./index.js";

// The Ecosystem Registry (ADR 0001: internal curation, NOT a plugin system) is
// the single, closed set of descriptors the detect/store/sandbox/egress sites
// derive from. These tests are a parametrized round-trip over EVERY descriptor:
// they pin the exact strings, Toolchain expression, install commands, and registry
// hosts that the dispatch sites encode (ADR 0012: the Store realizes only the
// Toolchain; Project Deps install in-Sandbox via the install command). The impurity
// machinery (impuritySignal, the bun provisionGate, the impuritySignal↔installCommand
// biconditional) is gone — every manager installs impurely (ADR 0012), so there is
// no signal to read and no gate to honour.

describe("Ecosystem Registry (ADR 0001 internal curation)", () => {
  it("exposes the closed Ecosystem list, ordered go then node then python then rust", () => {
    expect(ECOSYSTEMS.map((e) => e.ecosystem)).toEqual(["go", "node", "python", "rust"]);
  });

  it("curates exactly the nine known Package Managers", () => {
    expect([...PACKAGE_MANAGERS].sort()).toEqual([
      "bun",
      "cargo",
      "go",
      "npm",
      "pip",
      "pnpm",
      "poetry",
      "uv",
      "yarn",
    ]);
  });

  describe.each(PACKAGE_MANAGERS)("Package Manager descriptor: %s", (pm) => {
    const d = packageManagerDescriptor(pm);

    it("keys on its own closed packageManager name", () => {
      expect(d.packageManager).toBe(pm);
    });

    it("declares at least one lockfile", () => {
      expect(d.lockfiles.length).toBeGreaterThan(0);
    });

    it("generates a Toolchain-ONLY NixBuild the store realizes (no deps FOD)", () => {
      const build = d.generateToolchain({ pname: "sample" });
      expect(build.attr.length).toBeGreaterThan(0);
      expect(build.expression).toContain('pname = "sample"');
      // ADR 0012: the Store realizes only the Toolchain — no deps FOD / Importer.
      expect(build.expression).not.toContain("fetchCargoVendor");
      expect(build.expression).not.toContain("buildNpmPackage");
      expect(build.expression).not.toContain("pip download");
      expect(build.expression).not.toContain("vendorHash");
    });
  });

  describe("the Toolchain attr each manager realizes (ADR 0001/0012)", () => {
    it.each(["npm", "pnpm", "yarn", "bun"] as const)("%s realizes the nodejs Toolchain", (pm) => {
      const build = packageManagerDescriptor(pm).generateToolchain({ pname: "p" });
      expect(build.attr).toBe("nodejs");
      expect(build.expression).toContain("pkgs.nodejs");
    });

    it("go realizes the go Toolchain attr", () => {
      const build = packageManagerDescriptor("go").generateToolchain({ pname: "p" });
      expect(build.attr).toBe("go");
      expect(build.expression).toContain("pkgs.go");
    });

    it("cargo realizes the Rust Toolchain attr (rustc + cargo + cc, no deps FOD)", () => {
      const build = packageManagerDescriptor("cargo").generateToolchain({ pname: "p" });
      expect(build.attr).toBe("toolchain");
      expect(build.expression).toContain("pkgs.rustc");
      expect(build.expression).toContain("pkgs.cargo");
    });

    it("cargo ignores the recorded Toolchain version in v1 (builds with nixpkgs default)", () => {
      const unpinned = packageManagerDescriptor("cargo").generateToolchain({ pname: "p" });
      const pinned = packageManagerDescriptor("cargo").generateToolchain({
        pname: "p",
        toolchainVersion: "1.76.0",
      });

      expect(pinned).toEqual(unpinned);
    });
  });

  describe("the impurity machinery is gone (ADR 0012 — every manager installs impurely)", () => {
    // No more impuritySignal, no more biconditional, no bun provisionGate: every
    // detected manager installs impurely in-Sandbox, so there is no signal to read
    // and no gate to honour. These pin the ABSENCE so a re-added field fails the test.
    it.each([...PACKAGE_MANAGERS])("%s carries no impuritySignal (the lockfile reader is gone)", (pm) => {
      const d = packageManagerDescriptor(pm) as unknown as Record<string, unknown>;
      expect(d.impuritySignal).toBeUndefined();
    });

    it.each([...PACKAGE_MANAGERS])("%s carries no provisionGate (bun's gate is dropped)", (pm) => {
      const d = packageManagerDescriptor(pm) as unknown as Record<string, unknown>;
      expect(d.provisionGate).toBeUndefined();
    });

    it("bun installs through the normal path, with no gate", () => {
      const d = packageManagerDescriptor("bun") as unknown as Record<string, unknown>;
      expect(d.provisionGate).toBeUndefined();
      // bun provisions like every other manager: a real install command, no gate.
      expect(packageManagerDescriptor("bun").installCommand).toEqual(["bun install --frozen-lockfile"]);
    });
  });

  describe("every manager carries a canonical install command (ADR 0012 always-impure)", () => {
    // Deps now ALWAYS install in-Sandbox via the sandcastle hook (ADR 0012): there is
    // no pure-vs-impure decision, so EVERY detected manager must carry an install
    // command — go and cargo included (formerly pure-only). The install runs the real
    // Package Manager, frozen to the committed lockfile where possible, resolving when not.
    it.each([...PACKAGE_MANAGERS])("%s carries a non-empty installCommand", (pm) => {
      const cmds = packageManagerDescriptor(pm).installCommand;
      expect(cmds).toBeDefined();
      expect(cmds.length).toBeGreaterThan(0);
    });

    it("go fetches its modules in-Sandbox, cargo fetches its crates", () => {
      expect(packageManagerDescriptor("go").installCommand).toEqual(["go mod download"]);
      expect(packageManagerDescriptor("cargo").installCommand).toEqual(["cargo fetch"]);
    });

    // Standing egress (ADR 0012): egress no longer branches on purity, so EVERY
    // detected manager contributes its registry. `registryHost` is therefore REQUIRED
    // on every descriptor (go/cargo included) — proven at `tsc`, not by a runtime
    // biconditional — so a polyglot repo opens every registry and egress.ts never
    // silently reaches no host (architecture review candidate 1).
    it.each([...PACKAGE_MANAGERS])("%s carries a required registryHost", (pm) => {
      expect(packageManagerDescriptor(pm).registryHost.length).toBeGreaterThan(0);
    });

    it("the node managers name their registry, the python managers name pypi", () => {
      expect(packageManagerDescriptor("npm").registryHost).toBe("registry.npmjs.org");
      expect(packageManagerDescriptor("pnpm").registryHost).toBe("registry.npmjs.org");
      expect(packageManagerDescriptor("bun").registryHost).toBe("registry.npmjs.org");
      expect(packageManagerDescriptor("yarn").registryHost).toBe("registry.yarnpkg.com");
      expect(packageManagerDescriptor("pip").registryHost).toBe("pypi.org");
      expect(packageManagerDescriptor("uv").registryHost).toBe("pypi.org");
      expect(packageManagerDescriptor("poetry").registryHost).toBe("pypi.org");
    });

    it("go names the module proxy and cargo names the crates index (standing Build Egress)", () => {
      expect(packageManagerDescriptor("go").registryHost).toBe("proxy.golang.org");
      expect(packageManagerDescriptor("cargo").registryHost).toBe("index.crates.io");
    });

    describe("node managers install strictly from the committed lockfile (frozen/immutable)", () => {
      it("npm runs npm ci", () => {
        expect(packageManagerDescriptor("npm").installCommand).toEqual(["npm ci"]);
      });
      it("pnpm runs a frozen-lockfile install", () => {
        expect(packageManagerDescriptor("pnpm").installCommand).toEqual(["pnpm install --frozen-lockfile"]);
      });
      it("yarn runs a frozen-lockfile install", () => {
        expect(packageManagerDescriptor("yarn").installCommand).toEqual(["yarn install --frozen-lockfile"]);
      });
      it("bun runs a frozen-lockfile install through the normal path (no gate)", () => {
        expect(packageManagerDescriptor("bun").installCommand).toEqual(["bun install --frozen-lockfile"]);
      });
    });

    describe("python managers install into ./site (where the install lands and PYTHONPATH points)", () => {
      // The uv/poetry lists prepend their in-Sandbox `export` step before one shared
      // pip-into-site command. pip consumes requirements.txt directly, so it has no
      // export step — just the shared install (ADR 0012, always-impure in-Sandbox).
      const sharedPipInstall = "pip install --require-hashes -r requirements.txt --target site";

      it("pip is just the shared pip-into-site install (no export step)", () => {
        expect(packageManagerDescriptor("pip").installCommand).toEqual([sharedPipInstall]);
      });

      it("uv exports its hash-pinned requirements, then installs them into site", () => {
        expect(packageManagerDescriptor("uv").installCommand).toEqual([
          "uv export --format requirements-txt -o requirements.txt",
          sharedPipInstall,
        ]);
      });

      it("poetry exports its hash-pinned requirements, then installs them into site", () => {
        expect(packageManagerDescriptor("poetry").installCommand).toEqual([
          "poetry export --format requirements.txt -o requirements.txt",
          sharedPipInstall,
        ]);
      });
    });
  });

  describe("the FOD/Importer machinery is gone (ADR 0012 — deps install in-Sandbox)", () => {
    it.each(PACKAGE_MANAGERS)("%s carries no pin-then-pure or export front-end descriptor data", (pm) => {
      const d = packageManagerDescriptor(pm) as unknown as Record<string, unknown>;
      // `lockOnlyResolve` (pin-then-pure) and `exportFrontEnd` only fed the deleted
      // deps FOD; the in-Sandbox install replaces both. They are off the descriptor.
      expect(d.lockOnlyResolve).toBeUndefined();
      expect(d.exportFrontEnd).toBeUndefined();
      // `generateBuild` (the FOD expression) is replaced by `generateToolchain`.
      expect(d.generateBuild).toBeUndefined();
      expect(typeof packageManagerDescriptor(pm).generateToolchain).toBe("function");
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

    it("python's manifest markers are pyproject.toml/requirements.txt/setup.py", () => {
      const python = ecosystemFor("python");
      expect(python.manifests).toEqual(["pyproject.toml", "requirements.txt", "setup.py"]);
      // uv > poetry > pip in precedence (uv.lock > poetry.lock > requirements.txt).
      expect(python.managers).toEqual(["uv", "poetry", "pip"]);
      expect(python.defaultManager).toBe("pip");
    });

    it("generates a Toolchain-ONLY NixBuild the store realizes (the interpreter with pip)", () => {
      const build = packageManagerDescriptor("pip").generateToolchain({ pname: "sample" });
      expect(build.attr).toBe("python");
      // ADR 0012: the Toolchain ships pip + pytest; the deps pip-FOD is gone.
      expect(build.expression).toContain("withPackages");
      expect(build.expression).not.toContain("pip download");
      expect(build.expression).not.toContain("outputHash");
    });

    it("builds the Toolchain against the resolved interpreter (ADR 0006b)", () => {
      const build = packageManagerDescriptor("pip").generateToolchain({
        pname: "sample",
        toolchainVersion: "python311",
      });
      expect(build.expression).toContain("pkgs.python311");
    });
  });

  describe("the uv Package Manager shares the Python Toolchain (laimk-hse.6)", () => {
    it("registers uv as a python Package Manager", () => {
      const uv = packageManagerDescriptor("uv");
      expect(uv.ecosystem).toBe("python");
    });

    it("signals on uv.lock (the real lockfile that beats requirements.txt)", () => {
      expect(packageManagerDescriptor("uv").lockfiles).toEqual(["uv.lock"]);
    });

    it("shares the SAME Python Toolchain as pip (only the install command differs)", () => {
      const uvBuild = packageManagerDescriptor("uv").generateToolchain({ pname: "sample" });
      const pipBuild = packageManagerDescriptor("pip").generateToolchain({ pname: "sample" });
      expect(uvBuild).toEqual(pipBuild);
    });
  });

  describe("the poetry Package Manager shares the Python Toolchain (laimk-hse.7)", () => {
    it("registers poetry as a python Package Manager", () => {
      const poetry = packageManagerDescriptor("poetry");
      expect(poetry.ecosystem).toBe("python");
    });

    it("signals on poetry.lock", () => {
      expect(packageManagerDescriptor("poetry").lockfiles).toEqual(["poetry.lock"]);
    });

    it("shares the SAME Python Toolchain as pip (only the install command differs)", () => {
      const poetryBuild = packageManagerDescriptor("poetry").generateToolchain({ pname: "sample" });
      const pipBuild = packageManagerDescriptor("pip").generateToolchain({ pname: "sample" });
      expect(poetryBuild).toEqual(pipBuild);
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

    it("rust's manifest markers are Cargo.toml/Cargo.lock and its sole manager is cargo", () => {
      const rust = ecosystemFor("rust");
      expect(rust.managers).toEqual(["cargo"]);
      expect(rust.defaultManager).toBe("cargo");
      expect(rust.manifests).toEqual(["Cargo.toml", "Cargo.lock"]);
      expect(packageManagerDescriptor("cargo").lockfiles).toEqual(["Cargo.lock"]);
    });

    describe("each Ecosystem carries its in-Sandbox install stage dir (ADR 0002/0012)", () => {
      // The stage dir the in-Sandbox install lands in lives on the descriptor, not in
      // a per-Ecosystem `if` ladder in setupFor. The deleted `storeSubpath` (the pure
      // Store-staging source) is gone — deps install in-Sandbox, not copied from the Store.
      it("node installs into node_modules", () => {
        expect(ecosystemFor("node").sandbox.stageDir).toBe("node_modules");
      });

      it("python installs into site (PYTHONPATH points there)", () => {
        expect(ecosystemFor("python").sandbox.stageDir).toBe("site");
      });

      it("go's stage dir is vendor", () => {
        expect(ecosystemFor("go").sandbox.stageDir).toBe("vendor");
      });

      it("rust installs into the CARGO_HOME basename", () => {
        expect(ecosystemFor("rust").sandbox.stageDir).toBe(CARGO_HOME_BASENAME);
      });

      it("no Ecosystem carries the deleted pure-staging storeSubpath", () => {
        for (const eco of ["node", "python", "go", "rust"] as const) {
          expect((ecosystemFor(eco).sandbox as unknown as Record<string, unknown>).storeSubpath).toBeUndefined();
        }
      });
    });

    describe("each Ecosystem's sandbox facet builds its run environment (ADR 0002)", () => {
      // The run env — the Toolchain on PATH plus the writable cache vars off the
      // read-only Store — lives on the descriptor, not in a per-Ecosystem `if`
      // ladder in envFor. `planSandbox` resolves these for the container.
      const bin = "/nix/store/abc-toolchain/bin";

      it("node puts the toolchain first, then the agent harness, with a writable npm cache", () => {
        // Nix Toolchain first (the PROJECT's node wins), then /usr/local/bin (bd/pi);
        // the Store is read-only, so npm's cache + home point to /tmp.
        expect(ecosystemFor("node").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          NPM_CONFIG_CACHE: "/tmp/npm-cache",
          XDG_CACHE_HOME: "/tmp/.cache",
          npm_config_update_notifier: "false",
        });
      });

      it("python puts the toolchain first, points PYTHONPATH at the staged site, writable pip cache", () => {
        expect(ecosystemFor("python").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          PYTHONPATH: "site",
          PIP_CACHE_DIR: "/tmp/pip-cache",
          XDG_CACHE_HOME: "/tmp/.cache",
        });
      });

      it("go fetches modules in-Sandbox (proxy on, no vendor), points the build cache at /tmp", () => {
        // Always-impure (ADR 0012): `go mod download` fetches from the module proxy
        // in-Sandbox, so GOPROXY is the default (not `off`) and deps are no longer
        // vendored. The build cache still points at writable /tmp off the RO Store.
        expect(ecosystemFor("go").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/bin:/bin`,
          GOTOOLCHAIN: "local",
          CGO_ENABLED: "0",
          GOCACHE: "/tmp/gocache",
          GOMODCACHE: "/tmp/gomodcache",
          GOENV: "off",
        });
      });

      it("rust points Cargo at a writable CARGO_HOME and fetches crates in-Sandbox", () => {
        // Always-impure (ADR 0012): `cargo fetch` downloads crates in-Sandbox, so
        // offline mode is OFF; CARGO_HOME points at the writable per-project basename.
        expect(ecosystemFor("rust").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          CARGO_HOME: CARGO_HOME_BASENAME,
          CARGO_TARGET_DIR: "/tmp/cargo-target",
        });
      });
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

    describe("rust reads rustup Toolchain version files (dustcastle-gy5.3)", () => {
      const rust = ecosystemFor("rust");

      it("honours rust-toolchain.toml [toolchain] channel before legacy rust-toolchain", () => {
        const versionFiles: Record<string, string | undefined> = {
          "rust-toolchain.toml": '[toolchain]\nchannel = "1.76.0"\n',
          "rust-toolchain": "stable\n",
        };

        const version = rust.readToolchainVersion?.({
          manifest: '[package]\nrust-version = "1.70"\n',
          readVersionFile: (name) => versionFiles[name],
        });
        expect(version).toBe("1.76.0");
      });

      it("ignores Cargo.toml rust-version because it is the MSRV floor, not a pin", () => {
        const version = rust.readToolchainVersion?.({
          manifest: '[package]\nrust-version = "1.70"\n',
          readVersionFile: () => undefined,
        });
        expect(version).toBeUndefined();
      });
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
