import { describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
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
  vendorHash: "sha256-3rWfWAVcCVj1RN1gAlwRThZe9M2mBNTViE6z3OVPs90=",
};
const detection: Detection = {
  ecosystem: "go",
  packageManager: "go",
  importer: "buildGoModule",
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
  vendorHash: "",
  npmDepsHash: "sha256-tuEfyePwlOy2/mOPdXbqJskO6IowvAP4DWg8xSZwbJw=",
};
const nodeDetection: Detection = {
  ecosystem: "node",
  packageManager: "npm",
  importer: "fetchNpmDeps",
  toolchainVersion: "22.11.0",
};

describe("planSandbox — Node pure path (ADR 0002/0004/0005)", () => {
  it("puts the nodejs Toolchain on PATH with a writable npm cache off the RO Store", () => {
    const env = planSandbox({ provisioned: nodeProvisioned, detection: nodeDetection })
      .podmanOptions.env ?? {};

    expect(env.PATH).toContain(`${nodeProvisioned.toolchainStorePath}/bin`);
    // The Store is read-only; npm's cache must point somewhere writable.
    expect(env.NPM_CONFIG_CACHE).toMatch(/^\/tmp\//);
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
  });
});

describe("planSandbox — Node impure `allow` path (ADR 0004/0005)", () => {
  it("opens scoped egress (not none, not unrestricted) and installs in the container", () => {
    // Impurity `allow` runs untrusted postinstall *with* network, so the deps
    // are NOT pre-built in the Store; the container runs a real `npm ci` under
    // an egress allowlist derived from detection (registry + git host).
    const plan = planSandbox({
      provisioned: nodeProvisioned,
      detection: nodeDetection,
      egress: { kind: "allowlist", hosts: ["registry.npmjs.org", "github.com"] },
    });

    // Not closed (it must reach the registry) and not the default open network.
    expect(plan.podmanOptions.network).not.toBe("none");
    expect(plan.podmanOptions.network).toBeDefined();
    // The allowlist is surfaced for the CLI to print (never silent).
    expect(plan.egress).toEqual({ kind: "allowlist", hosts: ["registry.npmjs.org", "github.com"] });
    // The impure path installs in the container (with scripts), not from the Store.
    expect(plan.setupCommands.join("\n")).toContain("npm ci");
  });

  it("installs with the detected manager, frozen to the lockfile (slice 2b)", () => {
    // The impure install must use the manager that signalled — and from the
    // committed lockfile (frozen/immutable), so an impure build still can't drift.
    const impure = { kind: "allowlist", hosts: ["registry.npmjs.org"] } as const;
    const cmd = (packageManager: string, importer: string) =>
      planSandbox({
        provisioned: nodeProvisioned,
        detection: { ecosystem: "node", packageManager, importer },
        egress: impure,
      }).setupCommands.join("\n");

    expect(cmd("pnpm", "fetchPnpmDeps")).toBe("pnpm install --frozen-lockfile");
    expect(cmd("yarn", "fetchYarnDeps")).toBe("yarn install --frozen-lockfile");
  });

  it("points the container's tooling at the egress proxy (production proxy by default)", () => {
    const env =
      planSandbox({
        provisioned: nodeProvisioned,
        detection: nodeDetection,
        egress: { kind: "allowlist", hosts: ["registry.npmjs.org"] },
      }).podmanOptions.env ?? {};

    // npm (and any HTTP tooling) is routed through the proxy, which enforces the
    // allowlist; the default targets the production proxy container by name.
    expect(env.HTTPS_PROXY).toBe("http://dustcastle-egress-proxy:8118");
    expect(env.npm_config_proxy).toBe("http://dustcastle-egress-proxy:8118");
  });

  it("lets the orchestration layer override the proxy url (the e2e's host proxy)", () => {
    const env =
      planSandbox({
        provisioned: nodeProvisioned,
        detection: nodeDetection,
        egress: { kind: "allowlist", hosts: ["registry.npmjs.org"] },
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
