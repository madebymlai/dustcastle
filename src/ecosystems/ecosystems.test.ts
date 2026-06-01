import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../nix/rust.js";
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

    it("generates a NixBuild whose attrs the store realizes", () => {
      const build = d.generateBuild({ pname: "sample", depsHash: "sha256-AAA=", src: "./src" });
      expect(build.attrs.toolchain.length).toBeGreaterThan(0);
      expect(build.attrs.deps).toBe("deps");
      expect(build.attrs.app).toBe("app");
      expect(build.expression).toContain('pname = "sample');
    });

    // outputHashField removed — Provisioned now uses a single depsHash field.
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

    it("cargo realizes the Rust toolchain attr", () => {
      const build = packageManagerDescriptor("cargo").generateBuild({ pname: "p", depsHash: "sha256-AAA=" });
      expect(build.attrs.toolchain).toBe("toolchain");
      expect(build.expression).toContain("fetchCargoVendor");
      expect(build.expression).toContain('cargoHash = "sha256-AAA="');
    });

    it("cargo ignores the recorded Toolchain version in v1 (builds with nixpkgs default)", () => {
      const unpinned = packageManagerDescriptor("cargo").generateBuild({ pname: "p", depsHash: "sha256-AAA=" });
      const pinned = packageManagerDescriptor("cargo").generateBuild({
        pname: "p",
        depsHash: "sha256-AAA=",
        toolchainVersion: "1.76.0",
      });

      expect(pinned).toEqual(unpinned);
    });
  });

  describe("the bun gate is a first-class honest state (ADR 0001), not an ad-hoc throw", () => {
    it("bun carries a provisionGate with its actionable no-canonical-importer reason", () => {
      const gate = packageManagerDescriptor("bun").provisionGate;
      expect(gate).toBeDefined();
      expect(gate?.reason).toMatch(/bun/i);
      expect(gate?.reason).toMatch(/no canonical|not yet supported/i);
    });

    it.each(["npm", "pnpm", "yarn", "go", "cargo"] as const)("%s has no provisionGate", (pm) => {
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

    it("cargo has no impuritySignal — it builds pure unconditionally", () => {
      expect(packageManagerDescriptor("cargo").impuritySignal).toBeUndefined();
    });
  });

  describe("the frozen impureInstall is present iff impurity is reachable (dustcastle-bbg.3)", () => {
    // Impurity is reachable for any manager whose descriptor carries an
    // `impuritySignal` (decideImpurity is ecosystem-agnostic), so the guarantee
    // that every such manager has an in-container install command is the invariant:
    // a manager carries `impureInstall` IFF it carries `impuritySignal`. go has
    // neither (it never goes impure); the other seven have both. This keeps a
    // half-added manager honest — anything that can reach the impure path is proven
    // to have an install command, without leaning on the type system (the field is
    // legitimately optional, since go has none).
    it.each([...PACKAGE_MANAGERS])("%s has impureInstall iff it has impuritySignal", (pm) => {
      const d = packageManagerDescriptor(pm);
      expect(d.impureInstall !== undefined).toBe(d.impuritySignal !== undefined);
    });

    it("go and cargo have neither (they build pure unconditionally)", () => {
      expect(packageManagerDescriptor("go").impureInstall).toBeUndefined();
      expect(packageManagerDescriptor("cargo").impureInstall).toBeUndefined();
    });

    describe("node managers install strictly from the committed lockfile (frozen/immutable)", () => {
      it("npm runs npm ci", () => {
        expect(packageManagerDescriptor("npm").impureInstall).toEqual(["npm ci"]);
      });
      it("pnpm runs a frozen-lockfile install", () => {
        expect(packageManagerDescriptor("pnpm").impureInstall).toEqual(["pnpm install --frozen-lockfile"]);
      });
      it("yarn runs a frozen-lockfile install", () => {
        expect(packageManagerDescriptor("yarn").impureInstall).toEqual(["yarn install --frozen-lockfile"]);
      });
      it("bun runs a frozen-lockfile install (uniform, though its provisionGate fires first)", () => {
        expect(packageManagerDescriptor("bun").impureInstall).toEqual(["bun install --frozen-lockfile"]);
      });
    });

    describe("python managers install into ./site (where the pure path stages and PYTHONPATH points)", () => {
      // The lists are CONSTRUCTED from each manager's existing `exportFrontEnd` plus
      // one shared pip-into-site command, so the export string is single-sourced
      // (not duplicated as a literal). pip consumes requirements.txt directly, so it
      // has no export step — just the shared install.
      const sharedPipInstall = "pip install --require-hashes -r requirements.txt --target site";

      it("pip is just the shared pip-into-site install (no export front-end)", () => {
        expect(packageManagerDescriptor("pip").impureInstall).toEqual([sharedPipInstall]);
      });

      it("uv exports its hash-pinned requirements, then installs them into site", () => {
        expect(packageManagerDescriptor("uv").impureInstall).toEqual([
          "uv export --format requirements-txt -o requirements.txt",
          sharedPipInstall,
        ]);
      });

      it("poetry exports its hash-pinned requirements, then installs them into site", () => {
        expect(packageManagerDescriptor("poetry").impureInstall).toEqual([
          "poetry export --format requirements.txt -o requirements.txt",
          sharedPipInstall,
        ]);
      });
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
      // bun is gated at provision; go has no loose pin step.
      expect(packageManagerDescriptor(pm).lockOnlyResolve).toBeUndefined();
    });

    it("cargo resolves a loose Cargo.toml with `cargo generate-lockfile` (dustcastle-gy5.4)", () => {
      const r = packageManagerDescriptor("cargo").lockOnlyResolve;
      expect(r).toEqual({
        kind: "command",
        command: "cargo",
        args: ["generate-lockfile"],
        lockfile: "Cargo.lock",
        // The host-side resolve isolates CARGO_HOME and scopes env under the shared
        // deny-by-default floor + the rustup vars (dustcastle-k4d / ADR 0005).
        execution: {
          isolatedHomeEnv: "CARGO_HOME",
          extraEnv: ["RUSTUP_HOME", "RUSTUP_TOOLCHAIN"],
        },
      });
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

    // depsHash replaced outputHashField — pip stores its hash in the single field.

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

    // depsHash replaced outputHashField — uv stores its hash in the single field.

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

    // depsHash replaced outputHashField — poetry stores its hash in the single field.

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

    it("rust's manifest markers are Cargo.toml/Cargo.lock and its sole manager is cargo", () => {
      const rust = ecosystemFor("rust");
      expect(rust.managers).toEqual(["cargo"]);
      expect(rust.defaultManager).toBe("cargo");
      expect(rust.manifests).toEqual(["Cargo.toml", "Cargo.lock"]);
      expect(packageManagerDescriptor("cargo").lockfiles).toEqual(["Cargo.lock"]);
    });

    describe("each Ecosystem carries its pure-staging sandbox facet (ADR 0002)", () => {
      // The PURE-path staging knowledge — which worktree dir deps land in and which
      // subpath of the deps Store to copy from — lives on the descriptor, not in a
      // per-Ecosystem `if` ladder in setupFor. `stageCommands` consumes these.
      it("node stages node_modules from the deps Store's node_modules subpath", () => {
        const { stageDir, storeSubpath } = ecosystemFor("node").sandbox;
        expect({ stageDir, storeSubpath }).toEqual({ stageDir: "node_modules", storeSubpath: "node_modules" });
      });

      it("python stages site from the pip-FOD's site subpath (PYTHONPATH points there)", () => {
        const { stageDir, storeSubpath } = ecosystemFor("python").sandbox;
        expect({ stageDir, storeSubpath }).toEqual({ stageDir: "site", storeSubpath: "site" });
      });

      it("go stages vendor from the WHOLE deps Store path (no subpath — the store path IS vendor)", () => {
        const { stageDir, storeSubpath } = ecosystemFor("go").sandbox;
        expect({ stageDir, storeSubpath }).toEqual({ stageDir: "vendor", storeSubpath: "" });
      });

      it("rust stages the CARGO_HOME basename from the WHOLE deps Store path", () => {
        const { stageDir, storeSubpath } = ecosystemFor("rust").sandbox;
        expect({ stageDir, storeSubpath }).toEqual({ stageDir: CARGO_HOME_BASENAME, storeSubpath: "" });
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

      it("go vendors deps, turns the proxy off, points the build cache at /tmp", () => {
        expect(ecosystemFor("go").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/bin:/bin`,
          GOFLAGS: "-mod=vendor",
          GOPROXY: "off",
          GOTOOLCHAIN: "local",
          CGO_ENABLED: "0",
          GOCACHE: "/tmp/gocache",
          GOENV: "off",
        });
      });

      it("rust points Cargo at the staged CARGO_HOME and forces offline mode", () => {
        expect(ecosystemFor("rust").sandbox.env(bin)).toEqual({
          PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
          CARGO_HOME: CARGO_HOME_BASENAME,
          CARGO_NET_OFFLINE: "true",
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
