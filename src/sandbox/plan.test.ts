import { describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../ecosystems/rust.js";
import type { Detection } from "../detect/index.js";
import type { PackageManager } from "../ecosystems/index.js";
import type { Provisioned } from "../store/index.js";
import { planSandbox } from "./plan.js";

// The integration surface is just sandcastle's `mounts` array (ADR 0002): no
// fork, no patch. planSandbox turns a provisioned Store into the podman()
// provider options + the per-project setup the Sandbox needs. These tests pin
// the seam — what dustcastle hands sandcastle.
//
// Deps are ALWAYS installed in-Sandbox now (ADR 0012, always-impure): the Store
// realizes only the Toolchain, and the real Package Manager runs on
// onSandboxReady (`setupCommands`) into the Ecosystem's stage dir. There is no
// pure-vs-impure decision and no staging from a deps Store path.

const provisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/33fw-go-1.26.3",
};
const detection: Detection = {
  ecosystem: "go",
  packageManager: "go",
  toolchainVersion: "1.26.3",
};

describe("planSandbox (ADR 0002 mounts seam, ADR 0005 access)", () => {
  it("bind-mounts the physical Store read-only at the canonical /nix/store", () => {
    const plan = planSandbox({ ecosystems: [{ provisioned, detection }] });

    expect(plan.podmanOptions.mounts).toContainEqual({
      hostPath: provisioned.physStoreRoot,
      sandboxPath: "/nix/store",
      readonly: true,
    });
  });

  it("puts the Toolchain on PATH and configures Go to fetch its modules in-Sandbox", () => {
    const env = planSandbox({ ecosystems: [{ provisioned, detection }] }).podmanOptions.env ?? {};

    // The `go` binary comes from the shared Store, at its canonical path.
    expect(env.PATH).toContain(`${provisioned.toolchainStorePath}/bin`);
    // `go test` needs a writable cache, not a writable Store (spike finding).
    expect(env.GOCACHE).toBe("/tmp/gocache");
    // Always-impure (ADR 0012): the module proxy is ON so `go mod download` fetches
    // in-Sandbox; deps are no longer vendored from the Store.
    expect(env.GOPROXY).not.toBe("off");
    expect(env.GOFLAGS).not.toBe("-mod=vendor");
  });

  it("leaves sandbox networking open/default for a detected Ecosystem (ADR 0020)", () => {
    // dustcastle manages Toolchains and Project Deps; it no longer installs a
    // custom network or proxy posture. Omitting `network` lets sandcastle's
    // podman provider use normal container networking.
    expect(planSandbox({ ecosystems: [{ provisioned, detection }] }).podmanOptions.network).toBeUndefined();
  });

  it("installs Project Deps in-Sandbox (no staging from a deps Store path)", () => {
    // `go test` reads its modules; always-impure fetches them in-Sandbox via the
    // in-Sandbox install, never `cp -RL` from the Store.
    const setup = planSandbox({ ecosystems: [{ provisioned, detection }] }).setupCommands.join("\n");

    expect(setup).not.toContain("cp -RL");
    expect(setup).toContain("go mod download");
  });

  it("does not surface an egress decision on the plan (ADR 0020)", () => {
    expect(planSandbox({ ecosystems: [{ provisioned, detection }] })).not.toHaveProperty("egress");
  });
});

// Node provisioning: the Toolchain is nodejs and deps install in-Sandbox via the
// detected manager (always-impure). Only the Toolchain is in the Store
// (store/index.ts).
const nodeProvisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/nnnn-nodejs-22.11.0",
};
const nodeDetection: Detection = {
  ecosystem: "node",
  packageManager: "npm",
  toolchainVersion: "22.11.0",
};

const rustProvisioned: Provisioned = {
  mode: "bwrap",
  physStoreRoot: "/home/agent/.nix-portable/nix/store",
  toolchainStorePath: "/nix/store/rrrr-rust-toolchain",
};
const rustDetection: Detection = { ecosystem: "rust", packageManager: "cargo" };

describe("planSandbox — Rust path (dustcastle-gy5.2)", () => {
  it("fetches cargo deps in-Sandbox over normal container networking", () => {
    const plan = planSandbox({ ecosystems: [{ provisioned: rustProvisioned, detection: rustDetection }] });
    const setup = plan.setupCommands.join("\n");
    const env = plan.podmanOptions.env ?? {};

    expect(plan.podmanOptions.network).toBeUndefined();
    expect(plan).not.toHaveProperty("egress");
    expect(setup).not.toContain("cp -RL");
    expect(setup).toContain("cargo fetch");
    expect(env.PATH).toContain(`${rustProvisioned.toolchainStorePath}/bin`);
    expect(env.CARGO_HOME).toBe(CARGO_HOME_BASENAME);
    expect(env.CARGO_NET_OFFLINE).not.toBe("true");
  });
});

describe("planSandbox — Node always-impure path (ADR 0012)", () => {
  it("puts the nodejs Toolchain on PATH with a writable npm cache off the RO Store", () => {
    const env = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] })
      .podmanOptions.env ?? {};

    expect(env.PATH).toContain(`${nodeProvisioned.toolchainStorePath}/bin`);
    // The Store is read-only; npm's cache must point somewhere writable.
    expect(env.NPM_CONFIG_CACHE).toMatch(/^\/tmp\//);
  });

  it("keeps the agent harness (/usr/local/bin: bd, pi) on PATH, after the Toolchain", () => {
    // The image installs bd/pi to /usr/local/bin; the implement phase shells `bd show`.
    // The Nix Toolchain must still win for the PROJECT, so /usr/local/bin comes AFTER it.
    const env = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] }).podmanOptions.env ?? {};
    const path = env.PATH ?? "";
    expect(path).toContain("/usr/local/bin");
    expect(path.indexOf(`${nodeProvisioned.toolchainStorePath}/bin`)).toBeLessThan(path.indexOf("/usr/local/bin"));
  });

  it("installs node_modules in-Sandbox via the detected manager (npm install), with normal networking", () => {
    const plan = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] });
    const setup = plan.setupCommands.join("\n");

    expect(plan.podmanOptions.network).toBeUndefined();
    expect(plan).not.toHaveProperty("egress");
    // The install runs in-Sandbox; nothing is staged from the Store.
    expect(setup).toContain("npm install");
    expect(setup).not.toContain("cp -RL");
  });

  it("installs with the detected manager's resolving command (pnpm/yarn, no --frozen-lockfile)", () => {
    const cmd = (packageManager: PackageManager) =>
      planSandbox({
        ecosystems: [{ provisioned: nodeProvisioned, detection: { ecosystem: "node", packageManager } }],
      }).setupCommands.at(-1);

    expect(cmd("pnpm")).toContain("pnpm install");
    expect(cmd("pnpm")).not.toContain("--frozen-lockfile");
    expect(cmd("yarn")).toContain("yarn install");
    expect(cmd("yarn")).not.toContain("--frozen-lockfile");
  });

  it("does not point the container's tooling at a dustcastle egress proxy", () => {
    const env = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] }).podmanOptions.env ?? {};

    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.npm_config_proxy).toBeUndefined();
    expect(env.npm_config_https_proxy).toBeUndefined();
  });
});

describe("planSandbox — staging dir excluded from the worktree's git (dustcastle-8dk)", () => {
  // dustcastle's in-Sandbox install lands in a worktree-relative dir
  // (node_modules/site/vendor). That dir is a build artifact, never project state
  // — so it must be excluded from the worktree's git, or the agent's `git add`
  // (and sandcastle's untracked-sync, which honours --exclude-standard) would
  // capture the installed deps, bloating the reviewer's `git diff` and leaking
  // them on merge. We register it in the worktree's `.git/info/exclude` (NOT the
  // project's tracked .gitignore) as the first setup step, before installing.
  it("excludes node_modules in the worktree's git before installing it", () => {
    const setup = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] }).setupCommands;
    const joined = setup.join("\n");

    // Targets the worktree's git exclude file, not the project's tracked .gitignore.
    expect(setup[0]).toContain("git rev-parse --git-path info/exclude");
    // The active Ecosystem's staging dir is what gets excluded.
    expect(setup[0]).toContain("node_modules");
    // Excluded BEFORE the in-Sandbox install runs.
    expect(joined.indexOf("info/exclude")).toBeLessThan(joined.indexOf("npm install"));
  });

  it("excludes vendor for a go build (the staging dir is read from the Registry)", () => {
    const setup = planSandbox({ ecosystems: [{ provisioned, detection }] }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain("vendor");
  });

  it("excludes site for a python build", () => {
    const setup = planSandbox({
      ecosystems: [
        {
          provisioned: { ...nodeProvisioned, toolchainStorePath: "/nix/store/pppp-python3-3.12" },
          detection: { ecosystem: "python", packageManager: "pip" },
        },
      ],
    }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain("site");
  });

  it("excludes the staged CARGO_HOME basename for a rust build", () => {
    const setup = planSandbox({ ecosystems: [{ provisioned: rustProvisioned, detection: rustDetection }] }).setupCommands;
    expect(setup[0]).toContain("info/exclude");
    expect(setup[0]).toContain(CARGO_HOME_BASENAME);
  });

  it("appends idempotently — only when the entry is not already present", () => {
    const setup = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] }).setupCommands;
    expect(setup[0]).toMatch(/grep -qxF '[^']+'[^|]*\|\|[^>]*>>/);
  });
});

describe("planSandbox — Python always-impure path installs into ./site", () => {
  // python's in-Sandbox install lands in ./site — the same dir PYTHONPATH points
  // at, so the run env is identical regardless of manager. One resolving pip line
  // installs it: hashes are auto-verified when present, a loose file resolves.
  const pythonProvisioned: Provisioned = {
    mode: "bwrap",
    physStoreRoot: nodeProvisioned.physStoreRoot,
    toolchainStorePath: "/nix/store/pppp-python3-3.12",
  };

  const setup = (packageManager: PackageManager) =>
    planSandbox({
      ecosystems: [{ provisioned: pythonProvisioned, detection: { ecosystem: "python", packageManager } }],
    }).setupCommands;

  it("a loose / unpinned requirements.txt installs by resolving — no --require-hashes (dustcastle-6ta)", () => {
    // The reported failure: a hand-written requirements.txt of bare names + `>=`
    // ranges is loose (nothing is `==`-pinned with a hash). The in-Sandbox install
    // must RESOLVE it, not demand `--require-hashes` — which hard-fails on an
    // unpinned file ("all requirements must have their versions pinned with ==").
    const cmds = planSandbox({
      ecosystems: [
        { provisioned: pythonProvisioned, detection: { ecosystem: "python", packageManager: "pip", loose: true } },
      ],
    }).setupCommands;
    const joined = cmds.join("\n");
    expect(joined).not.toContain("--require-hashes");
    expect(cmds.at(-1)).toBe("pip install -r requirements.txt --target site");
  });

  it("pip installs its committed requirements straight into ./site (no empty cp)", () => {
    const cmds = setup("pip");
    // The install command follows the prepended worktree git-exclude.
    expect(cmds.at(-1)).toContain("pip install -r requirements.txt --target site");
    expect(cmds.join("\n")).not.toContain("cp -RL");
  });

  it("uv exports its hash-pinned requirements first, then installs them into ./site", () => {
    expect(setup("uv").slice(1)).toEqual([
      "uv export --format requirements-txt -o requirements.txt",
      "pip install -r requirements.txt --target site",
    ]);
  });

  it("poetry exports its hash-pinned requirements first, then installs them into ./site", () => {
    expect(setup("poetry").slice(1)).toEqual([
      "poetry export --format requirements.txt -o requirements.txt",
      "pip install -r requirements.txt --target site",
    ]);
  });

  it("uses normal networking and points PYTHONPATH at the installed site", () => {
    const plan = planSandbox({
      ecosystems: [{ provisioned: pythonProvisioned, detection: { ecosystem: "python", packageManager: "uv" } }],
    });
    expect(plan.podmanOptions.network).toBeUndefined();
    expect((plan.podmanOptions.env ?? {}).PYTHONPATH).toBe("site");
  });
});

describe("planSandbox — polyglot Node + Python (ADR 0012 multi-ecosystem)", () => {
  // A polyglot repo provisions BOTH toolchains and installs BOTH dep sets in one
  // Sandbox: each detected Ecosystem's install runs in-Sandbox into its own stage
  // dir, and the run env merges every Ecosystem's PATH/cache vars.
  const pythonProvisioned: Provisioned = {
    mode: "bwrap",
    physStoreRoot: nodeProvisioned.physStoreRoot,
    toolchainStorePath: "/nix/store/pppp-python3-3.12",
  };

  const plan = planSandbox({
    ecosystems: [
      { provisioned: nodeProvisioned, detection: nodeDetection },
      { provisioned: pythonProvisioned, detection: { ecosystem: "python", packageManager: "pip" } },
    ],
  });

  it("installs BOTH dep sets in one Sandbox", () => {
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("npm install");
    expect(setup).toContain("pip install -r requirements.txt --target site");
  });

  it("excludes BOTH stage dirs from the worktree's git before installing", () => {
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("node_modules");
    expect(setup).toContain("site");
    // each install is preceded by its own info/exclude entry
    expect(setup.indexOf("info/exclude")).toBeLessThan(setup.indexOf("npm install"));
  });

  it("puts BOTH toolchains on PATH and merges each Ecosystem's run env", () => {
    const env = plan.podmanOptions.env ?? {};
    expect(env.PATH).toContain(`${nodeProvisioned.toolchainStorePath}/bin`);
    expect(env.PATH).toContain(`${pythonProvisioned.toolchainStorePath}/bin`);
    // node + python cache vars both present
    expect(env.NPM_CONFIG_CACHE).toMatch(/^\/tmp\//);
    expect(env.PYTHONPATH).toBe("site");
  });
});

describe("planSandbox — deps-cache hit/miss decision (ADR 0016)", () => {
  // Per-ecosystem deps cache: the host decides hit/miss per ecosystem (keyed by its
  // deps key) and the plan emits the right hooks. HIT → restore from the cache
  // via host.onWorktreeReady (copy the assembled deps into the worktree's stage dir)
  // and run NO install. MISS → install in-Sandbox via sandbox.onSandboxReady, then
  // populate the cache entry from the worktree's stage dir after the run.

  it("a cache HIT restores via host.onWorktreeReady and runs NO install", () => {
    const plan = planSandbox({
      ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "abc123", hit: true } }],
      cacheDir: "/home/u/.dustcastle/deps-cache",
    });

    // Restore copies the assembled deps from the cache entry into the worktree's
    // stage dir, before the Sandbox starts (cp -RL + chmod self-heal, like the old
    // Store staging). It targets node_modules and reads the deps-key entry.
    const restore = plan.hostWorktreeReady.join("\n");
    expect(restore).toContain("cp -RL");
    expect(restore).toContain("/home/u/.dustcastle/deps-cache/abc123/node_modules");
    expect(restore).toContain("node_modules");

    // The in-Sandbox setup runs only the git-exclude — no install command.
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("info/exclude");
    expect(setup).not.toContain("npm install");

    // Nothing to populate on a hit.
    expect(plan.populate).toEqual([]);
  });

  it("a cache HIT bumps the entry's recency so a frequently-used entry stays warm under GC", () => {
    const plan = planSandbox({
      ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "abc123", hit: true } }],
      cacheDir: "/home/u/.dustcastle/deps-cache",
    });

    // The GC pool reads each entry's recency from the ENTRY dir's mtime, but `cp -RL`
    // reads the source without touching it — so a hit must `touch` the entry dir, else
    // a hot-but-old entry looks stale and the byte-LRU could evict it despite active use.
    const restore = plan.hostWorktreeReady.join("\n");
    expect(restore).toContain("touch '/home/u/.dustcastle/deps-cache/abc123'");
  });

  it("a cache MISS installs in-Sandbox, then populates the cache entry after the run", () => {
    const plan = planSandbox({
      ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "def456", hit: false } }],
      cacheDir: "/home/u/.dustcastle/deps-cache",
    });

    // No restore copy on a miss.
    expect(plan.hostWorktreeReady).toEqual([]);

    // The install runs in-Sandbox (npm install) and touches the success sentinel only after it succeeds.
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("rm -f '.dustcastle-deps-install-success-node_modules' && npm install && touch '.dustcastle-deps-install-success-node_modules'");

    // The cache entry to populate after the run: the worktree's stage dir → the
    // deps-key entry dir.
    expect(plan.populate).toEqual([
      {
        depsKey: "def456",
        stageDir: "node_modules",
      },
    ]);
  });

  it("a loose / no-lockfile ecosystem is cacheable: a miss installs, then populates", () => {
    const plan = planSandbox({
      ecosystems: [
        {
          provisioned: nodeProvisioned,
          detection: { ...nodeDetection, loose: true },
          cache: { depsKey: "loosekey", hit: false },
        },
      ],
      cacheDir: "/home/u/.dustcastle/deps-cache",
    });

    expect(plan.hostWorktreeReady).toEqual([]);
    expect(plan.populate).toEqual([{ depsKey: "loosekey", stageDir: "node_modules" }]);
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("npm install");
    expect(setup).toContain("touch '.dustcastle-deps-install-success-node_modules'");
  });

  it("requires the run-level cache root for cacheable decisions", () => {
    expect(() =>
      planSandbox({
        ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "abc123", hit: true } }],
      }),
    ).toThrow("cacheDir is required when a deps-cache decision is supplied");
  });

  it("with no cache info at all (default), behaves like a miss with no caching", () => {
    // Backward-compatible default: existing callers that don't supply cache info get
    // the install (no restore, no populate) — the prior always-install behavior.
    const plan = planSandbox({ ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection }] });
    expect(plan.hostWorktreeReady).toEqual([]);
    expect(plan.populate).toEqual([]);
    const setup = plan.setupCommands.join("\n");
    expect(setup).toContain("npm install");
    expect(setup).not.toContain("dustcastle-deps-install-success");
  });

  it("a polyglot repo mixes hit + miss across its ecosystems in one Sandbox", () => {
    const pythonProvisioned: Provisioned = {
      mode: "bwrap",
      physStoreRoot: nodeProvisioned.physStoreRoot,
      toolchainStorePath: "/nix/store/pppp-python3-3.12",
    };
    // Node HITS its cache; Python MISSES its.
    const plan = planSandbox({
      ecosystems: [
        { provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "nodehash", hit: true } },
        {
          provisioned: pythonProvisioned,
          detection: { ecosystem: "python", packageManager: "pip" },
          cache: { depsKey: "pyhash", hit: false },
        },
      ],
      cacheDir: "/c",
    });

    const restore = plan.hostWorktreeReady.join("\n");
    const setup = plan.setupCommands.join("\n");

    // Node restores from cache and does NOT install npm.
    expect(restore).toContain("/c/nodehash/node_modules");
    expect(setup).not.toContain("npm install");
    // Python is a miss: it installs in-Sandbox and has nothing restored.
    expect(setup).toContain("pip install -r requirements.txt --target site");
    expect(restore).not.toContain("/c/pyhash");
    // Only Python is populated after the run.
    expect(plan.populate).toEqual([
      { depsKey: "pyhash", stageDir: "site" },
    ]);
  });

  it("a restore self-heals permissions the way the old Store staging did (chmod)", () => {
    const plan = planSandbox({
      ecosystems: [{ provisioned: nodeProvisioned, detection: nodeDetection, cache: { depsKey: "abc", hit: true } }],
      cacheDir: "/c",
    });
    expect(plan.hostWorktreeReady.join("\n")).toContain("chmod");
  });
});

