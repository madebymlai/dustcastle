import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../nix/rust.js";
import type { Detection } from "../detect/index.js";
import type { PackageManager } from "../ecosystems/index.js";
import type { Provisioned } from "../store/index.js";
import { planSandbox } from "./plan.js";

// The integration surface is just sandcastle's `mounts` array (ADR 0002): no
// fork, no patch. planSandbox turns a provisioned Store into the podman()
// provider options + the per-project setup the Sandbox needs. These tests pin
// the seam — what dustcastle hands sandcastle.

const provisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/33fw-go-1.26.3",
  depsStorePath: "/nix/store/cq9d-sample-0.0.0-go-modules",
  appStorePath: "/nix/store/aaaa-sample-0.0.0",
  depsHash: "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=",
};
const detection: Detection = {
  ecosystem: "go",
  packageManager: "go",
  toolchainVersion: "1.26.3",
};

describe("planSandbox (ADR 0002 mounts seam, ADR 0005 access)", () => {
  it("bind-mounts the physical Store read-only at the canonical /nix/store", () => {
    const plan = planSandbox({ provisioned, detection });

    expect(plan.podmanOptions.mounts).toContainEqual({
      hostPath: provisioned.physStoreRoot,
      sandboxPath: "/nix/store",
      readonly: true,
    });
  });

  it("puts the Toolchain on PATH and configures Go to read deps offline", () => {
    const env = planSandbox({ provisioned, detection }).podmanOptions.env ?? {};

    // The `go` binary comes from the shared Store, at its canonical path.
    expect(env.PATH).toContain(`${provisioned.toolchainStorePath}/bin`);
    // `go test` needs a writable cache, not a writable Store (spike finding).
    expect(env.GOCACHE).toBe("/tmp/gocache");
    // Deps are read from the vendored copy; the toolchain never reaches network.
    expect(env.GOFLAGS).toBe("-mod=vendor");
    expect(env.GOPROXY).toBe("off");
    expect(env.GOTOOLCHAIN).toBe("local");
  });

  it("runs with no network egress for a pure build (ADR 0005 scoped egress)", () => {
    // Pure-mode builds reach no network at all, so egress is closed entirely —
    // the safest default. The derived allowlist arrives with the impure path.
    expect(planSandbox({ provisioned, detection }).podmanOptions.network).toBe("none");
  });

  it("stages Project Deps from the read-only Store into the writable worktree", () => {
    // `go test -mod=vendor` reads a vendor/ dir; the deps live RO in the Store
    // mount, so the Sandbox copies them in (and makes them writable) on startup.
    const plan = planSandbox({ provisioned, detection });
    const setup = plan.setupCommands.join("\n");

    expect(setup).toContain(provisioned.depsStorePath);
    expect(setup).toContain("vendor");
  });

  it("surfaces the egress decision on the plan — never silent (ADR 0005)", () => {
    expect(planSandbox({ provisioned, detection }).egress).toEqual({ kind: "none" });
  });
});

// Node provisioning: the Toolchain is nodejs and the deps Store path holds the
// assembled node_modules (the importer's `--ignore-scripts` offline `npm ci`).
const nodeProvisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/nnnn-nodejs-22.11.0",
  depsStorePath: "/nix/store/dddd-app-deps-0.0.0",
  appStorePath: "/nix/store/dddd-app-deps-0.0.0",
  depsHash: "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=",
};
const nodeDetection: Detection = {
  ecosystem: "node",
  packageManager: "npm",
  toolchainVersion: "22.11.0",
};

// The impure `allow` path realizes only the Toolchain into the Store, so deps are
// installed in the container — depsStorePath is empty (store/index.ts). That empty
// path is the impurity signal planSandbox keys on (ADR 0010), NOT the egress shape.
const impureProvisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: nodeProvisioned.physStoreRoot,
  toolchainStorePath: nodeProvisioned.toolchainStorePath,
  depsStorePath: "", // impure: only the Toolchain is in the Store; deps install in-container
  appStorePath: nodeProvisioned.toolchainStorePath,
  depsHash: "",
};

const rustProvisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/rrrr-rust-toolchain",
  depsStorePath: "/nix/store/dddd-sample-cargo-deps",
  appStorePath: "/nix/store/aaaa-sample",
  depsHash: "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=",
};
const rustDetection: Detection = { ecosystem: "rust", packageManager: "cargo" };

describe("planSandbox — Rust pure path (dustcastle-gy5.2)", () => {
  it("stages CARGO_HOME from the Store and runs Cargo offline with no egress", () => {
    const plan = planSandbox({ provisioned: rustProvisioned, detection: rustDetection });
    const setup = plan.setupCommands.join("\n");
    const env = plan.podmanOptions.env ?? {};

    expect(plan.podmanOptions.network).toBe("none");
    expect(plan.egress).toEqual({ kind: "none" });
    expect(setup).toContain(`cp -RL ${rustProvisioned.depsStorePath} ${CARGO_HOME_BASENAME}`);
    expect(env.PATH).toContain(`${rustProvisioned.toolchainStorePath}/bin`);
    expect(env.CARGO_HOME).toBe(CARGO_HOME_BASENAME);
    expect(env.CARGO_NET_OFFLINE).toBe("true");
  });
});

describe("planSandbox — Node pure path (ADR 0002/0004/0005)", () => {
  it("puts the nodejs Toolchain on PATH with a writable npm cache off the RO Store", () => {
    const env = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection })
      .podmanOptions.env ?? {};

    expect(env.PATH).toContain(`${nodeProvisioned.toolchainStorePath}/bin`);
    // The Store is read-only; npm's cache must point somewhere writable.
    expect(env.NPM_CONFIG_CACHE).toMatch(/^\/tmp\//);
  });

  it("keeps the agent harness (/usr/local/bin: bd, pi) on PATH, after the Toolchain", () => {
    // The image installs bd/pi to /usr/local/bin; the implement phase shells `bd show`.
    // The Nix Toolchain must still win for the PROJECT, so /usr/local/bin comes AFTER it.
    const env = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection }).podmanOptions.env ?? {};
    const path = env.PATH ?? "";
    expect(path).toContain("/usr/local/bin");
    expect(path.indexOf(`${nodeProvisioned.toolchainStorePath}/bin`)).toBeLessThan(path.indexOf("/usr/local/bin"));
  });

  it("stages node_modules from the read-only Store and runs offline (no egress)", () => {
    const plan = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection });
    const setup = plan.setupCommands.join("\n");

    expect(plan.podmanOptions.network).toBe("none");
    expect(plan.egress).toEqual({ kind: "none" });
    // The deps store path (which contains node_modules) is copied into the worktree.
    expect(setup).toContain(nodeProvisioned.depsStorePath);
    expect(setup).toContain("node_modules");
    // Pure path never runs `npm ci` in the container — deps came from the Store.
    expect(setup).not.toContain("npm ci");
    // Clear the target before copying, and chmod it writable BEFORE the rm — a
    // read-only node_modules left by an interrupted prior staging (cp -RL copies the
    // Store's 555 mode) is otherwise un-removable, poisoning every later run.
    expect(setup).toContain("rm -rf node_modules");
    expect(setup.indexOf("rm -rf node_modules")).toBeLessThan(setup.indexOf("cp -RL"));
    expect(setup).toMatch(/chmod -R u\+w node_modules 2>\/dev\/null; rm -rf node_modules/);
  });
});

describe("planSandbox — staging dir excluded from the worktree's git (dustcastle-8dk)", () => {
  // dustcastle stages deps into a worktree-relative dir (node_modules/site/vendor).
  // That dir is a re-staged build artifact, never project state — so it must be
  // excluded from the worktree's git, or the agent's `git add` (and sandcastle's
  // untracked-sync, which honours --exclude-standard) would capture the staged deps,
  // bloating the reviewer's `git diff` and leaking them on merge. We register it in
  // the worktree's `.git/info/exclude` (NOT the project's tracked .gitignore) as the
  // first setup step, before staging — keyed on the SAME stageDir the staging reads.
  it("excludes node_modules in the worktree's git before staging it", () => {
    const setup = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection }).setupCommands;
    const joined = setup.join("\n");

    // Targets the worktree's git exclude file, not the project's tracked .gitignore.
    expect(setup[0]).toContain("git rev-parse --git-path info/exclude");
    // The active Ecosystem's staging dir is what gets excluded.
    expect(setup[0]).toContain("node_modules");
    // Excluded BEFORE the deps are staged in (so a fresh stage is never trackable).
    expect(joined.indexOf("info/exclude")).toBeLessThan(joined.indexOf("cp -RL"));
  });

  it("excludes node_modules before installing it on the impure path too", () => {
    // An impure build installs node_modules in the container — still a build
    // artifact, so it must be excluded just like the pure-staged copy.
    const setup = planSandbox({ provisioned: impureProvisioned, detection: nodeDetection }).setupCommands;
    const joined = setup.join("\n");

    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain("node_modules");
    // Excluded BEFORE the in-container install runs.
    expect(joined.indexOf("info/exclude")).toBeLessThan(joined.indexOf("npm ci"));
  });

  it("excludes vendor for a go build (the staging dir is read from the Registry)", () => {
    // `provisioned`/`detection` are the go fixtures: the exclude tracks go's stageDir.
    const setup = planSandbox({ provisioned, detection }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain("vendor");
  });

  it("excludes site for a python build", () => {
    const pythonPure: Provisioned = { ...provisioned, depsStorePath: "/nix/store/pppp-py-deps" };
    const setup = planSandbox({
      provisioned: pythonPure,
      detection: { ecosystem: "python", packageManager: "pip" },
    }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain("site");
  });

  it("excludes the staged CARGO_HOME basename for a rust build", () => {
    const rustPure: Provisioned = { ...provisioned, depsStorePath: "/nix/store/rrrr-cargo-deps" };
    const setup = planSandbox({
      provisioned: rustPure,
      detection: { ecosystem: "rust", packageManager: "cargo" },
    }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain(CARGO_HOME_BASENAME);
  });

  it("appends idempotently — only when the entry is not already present", () => {
    // Re-staging on every sandbox-ready must not pile duplicate lines into the
    // exclude: the command greps for the entry and appends only on a miss.
    const setup = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection }).setupCommands;
    expect(setup[0]).toMatch(/grep -qxF '[^']+'[^|]*\|\|[^>]*>>/);
  });
});

describe("planSandbox — Node impure `allow` path (ADR 0004/0005)", () => {
  const impureEgress = {
    kind: "allowlist",
    buildHosts: ["registry.npmjs.org", "github.com"],
    agentHosts: [],
  } as const;

  it("opens scoped egress (not none, not unrestricted) and installs in the container", () => {
    // Impurity `allow` runs untrusted postinstall *with* network, so the deps
    // are NOT pre-built in the Store (empty depsStorePath); the container runs a
    // real `npm ci` under an egress allowlist derived from detection.
    const plan = planSandbox({
      provisioned: impureProvisioned,
      detection: nodeDetection,
      egress: impureEgress,
    });

    // Not closed (it must reach the registry) and not the default open network.
    expect(plan.podmanOptions.network).not.toBe("none");
    expect(plan.podmanOptions.network).toBeDefined();
    // The allowlist is surfaced for the CLI to print (never silent).
    expect(plan.egress).toEqual(impureEgress);
    // The impure path installs in the container (with scripts), not from the Store.
    expect(plan.setupCommands.join("\n")).toContain("npm ci");
  });

  it("installs with the detected manager, frozen to the lockfile (slice 2b)", () => {
    // The impure install must use the manager that signalled — and from the
    // committed lockfile (frozen/immutable), so an impure build still can't drift.
    // The install is the last command — the worktree git-exclude (dustcastle-8dk)
    // is prepended ahead of it (and asserted separately).
    const cmd = (packageManager: PackageManager) =>
      planSandbox({
        provisioned: impureProvisioned,
        detection: { ecosystem: "node", packageManager },
        egress: impureEgress,
      }).setupCommands.at(-1);

    expect(cmd("pnpm")).toBe("pnpm install --frozen-lockfile");
    expect(cmd("yarn")).toBe("yarn install --frozen-lockfile");
  });

  it("points the container's tooling at the egress proxy (production proxy by default)", () => {
    const env =
      planSandbox({
        provisioned: impureProvisioned,
        detection: nodeDetection,
        egress: impureEgress,
      }).podmanOptions.env ?? {};

    // npm (and any HTTP tooling) is routed through the proxy, which enforces the
    // allowlist; the default targets the production proxy container by name.
    expect(env.HTTPS_PROXY).toBe("http://dustcastle-egress-proxy:8118");
    expect(env.npm_config_proxy).toBe("http://dustcastle-egress-proxy:8118");
  });

  it("lets the orchestration layer override the proxy url (the e2e's host proxy)", () => {
    const env =
      planSandbox({
        provisioned: impureProvisioned,
        detection: nodeDetection,
        egress: impureEgress,
        proxyUrl: "http://169.254.7.7:8118",
      }).podmanOptions.env ?? {};

    expect(env.HTTPS_PROXY).toBe("http://169.254.7.7:8118");
  });

  it("never sets proxy env on a pure (closed-egress) build", () => {
    const env =
      planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection }).podmanOptions.env ?? {};
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe("planSandbox — Python impure path stages into ./site (dustcastle-bbg.3 bugfix)", () => {
  // The latent bug this slice closes: python builds CAN go impure (a uv/poetry
  // project with an sdist dependency, ADR 0004) but setupFor's impure branch used
  // to live inside `if (ecosystem === "node")`, so a python impure build fell
  // through to the PURE python branch and `cp`-ed from an empty depsStorePath.
  // After the relocation onto PackageManagerDescriptor.impureInstall, a python
  // impure build installs into ./site — the same dir the pure path stages into and
  // PYTHONPATH points at, so the run env is identical pure or impure.
  //
  // The real assembly is DUSTCASTLE_E2E-gated (podman + nix), so the "end-to-end"
  // AC is satisfied here at the unit level: planSandbox emits the install commands.
  const pythonImpureProvisioned: Provisioned = {
    mode: "bwrap",
    physStoreRoot: nodeProvisioned.physStoreRoot,
    toolchainStorePath: "/nix/store/pppp-python3-3.12",
    depsStorePath: "", // impure: only the Toolchain is in the Store; deps install in-container
    appStorePath: "/nix/store/pppp-python3-3.12",
    depsHash: "",
  };
  const pythonImpureEgress = {
    kind: "allowlist",
    buildHosts: ["pypi.org", "files.pythonhosted.org"],
    agentHosts: [],
  } as const;

  const setup = (packageManager: PackageManager) =>
    planSandbox({
      provisioned: pythonImpureProvisioned,
      detection: { ecosystem: "python", packageManager },
      egress: pythonImpureEgress,
    }).setupCommands;

  it("pip installs its committed requirements straight into ./site (no empty cp)", () => {
    const cmds = setup("pip");
    // The install commands follow the prepended worktree git-exclude (dustcastle-8dk).
    expect(cmds.slice(1)).toEqual(["pip install --require-hashes -r requirements.txt --target site"]);
    // It must NOT fall through to the pure branch, which would cp from the empty path.
    expect(cmds.join("\n")).not.toContain("cp -RL");
  });

  it("uv exports its hash-pinned requirements first, then installs them into ./site", () => {
    expect(setup("uv").slice(1)).toEqual([
      "uv export --format requirements-txt -o requirements.txt",
      "pip install --require-hashes -r requirements.txt --target site",
    ]);
  });

  it("poetry exports its hash-pinned requirements first, then installs them into ./site", () => {
    expect(setup("poetry").slice(1)).toEqual([
      "poetry export --format requirements.txt -o requirements.txt",
      "pip install --require-hashes -r requirements.txt --target site",
    ]);
  });

  it("opens scoped egress and points PYTHONPATH at the staged site (run env identical to pure)", () => {
    const plan = planSandbox({
      provisioned: pythonImpureProvisioned,
      detection: { ecosystem: "python", packageManager: "uv" },
      egress: pythonImpureEgress,
    });
    expect(plan.podmanOptions.network).not.toBe("none");
    expect((plan.podmanOptions.env ?? {}).PYTHONPATH).toBe("site");
  });
});

describe("planSandbox — pure build with Agent Egress (ADR 0010 carve-out)", () => {
  // A pure build whose agent needs its LLM: the allowlist carries ONLY the model
  // host (agentHosts), buildHosts empty. The build stays pure — deps from the Store.
  const agentEgress = {
    kind: "allowlist",
    buildHosts: [],
    agentHosts: ["api.deepseek.com"],
  } as const;

  it("attaches the egress network and routes the agent through the proxy", () => {
    const plan = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection, egress: agentEgress });
    // Not closed — the agent must reach its model — but not unrestricted either.
    expect(plan.podmanOptions.network).not.toBe("none");
    expect(plan.podmanOptions.network).toBeDefined();
    // The agent's HTTP(S) calls route through the proxy (its only way out).
    expect((plan.podmanOptions.env ?? {}).HTTPS_PROXY).toBe("http://dustcastle-egress-proxy:8118");
  });

  it("STILL stages deps from the Store — opening agent egress does not turn it impure", () => {
    // The key decoupling (ADR 0010): impurity is read from depsStorePath, not the
    // egress shape. A pure build with an allowlist copies node_modules, never npm ci.
    const setup = planSandbox({
      provisioned: nodeProvisioned,
      detection: nodeDetection,
      egress: agentEgress,
    }).setupCommands.join("\n");

    expect(setup).toContain(nodeProvisioned.depsStorePath);
    expect(setup).toContain("node_modules");
    expect(setup).not.toContain("npm ci");
  });

  it("surfaces the agent-only allowlist on the plan (build offline, agent open)", () => {
    const plan = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection, egress: agentEgress });
    expect(plan.egress).toEqual(agentEgress);
  });
});
