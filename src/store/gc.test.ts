import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gcRootLink,
  pruneRecencyRoots,
  registerRecencyRoot,
  registerScopedRoots,
  rootStorePaths,
} from "./gc.js";
import type { NixResult } from "./nix.js";

// Store lifecycle (ADR 0007). The shared rootless /nix/store grows unbounded; 3b
// keeps it lean WITHOUT collecting paths a live run still needs: scoped GC roots
// (per-run, released on completion) pin the Toolchain closure, then a
// policy-driven optimise + collect-garbage frees the rest. The pure decisions
// (which paths root, command construction, report parsing) are unit-tested here;
// the live `nix-store --gc` is gated against a scratch store root.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });

describe("rootStorePaths (which paths a provision pins — ADR 0007)", () => {
  it("roots the toolchain closure only", () => {
    expect(rootStorePaths({ toolchainStorePath: "/nix/store/aaa-node" })).toEqual([
      { kind: "toolchain", path: "/nix/store/aaa-node" },
    ]);
  });
});

describe("gcRootLink (sanitized root-link construction — ADR 0007)", () => {
  it("keys the scoped-root link by project + toolchain kind (ADR 0007)", () => {
    const link = gcRootLink("/roots", "sha256-AbC/d+e=", "toolchain");
    expect(link.startsWith("/roots/")).toBe(true);
    expect(link.endsWith("-toolchain")).toBe(true);
    // The link name is filesystem-safe (no slashes from the key leak through).
    expect(link.slice("/roots/".length)).not.toContain("/");
  });
});

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("registerScopedRoots (per-run roots, released on completion — ADR 0007)", () => {
  it("adds a toolchain root and releases it by removing the link symlink", () => {
    const gcrootsDir = mkdtempSync(join(tmpdir(), "dustcastle-gcroots-"));
    tmps.push(gcrootsDir);
    const calls: string[][] = [];
    // Faithful runner: `nix-store --add-root <link>` creates the link (as real nix does).
    const run = (args: readonly string[]): NixResult => {
      calls.push([...args]);
      if (args[0] === "nix-store" && args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };

    const handle = registerScopedRoots({
      provisioned: { toolchainStorePath: "/nix/store/aaa-node" },
      gcrootsDir,
      projectKey: "sha256-deadbeef=",
      run,
    });

    // One add-root for the Toolchain path.
    const addRoots = calls.filter((c) => c[1] === "--add-root");
    expect(addRoots).toHaveLength(1);
    expect(addRoots.map((c) => c[4])).toEqual(["/nix/store/aaa-node"]);
    expect(handle.links).toHaveLength(1);
    expect(handle.links.every((l) => existsSync(l))).toBe(true);

    // Releasing the scoped root removes the link symlink (closure becomes collectable).
    handle.release();
    expect(handle.links.some((l) => existsSync(l))).toBe(false);
  });
});

describe("registerRecencyRoot / pruneRecencyRoots (the persistent warm roots — ADR 0007)", () => {
  it("registers a persistent toolchain root (not released with the run)", () => {
    const recencyRootsDir = mkdtempSync(join(tmpdir(), "dustcastle-recency-roots-"));
    tmps.push(recencyRootsDir);
    const run = (args: readonly string[]): NixResult => {
      if (args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };

    const { links } = registerRecencyRoot({
      provisioned: { toolchainStorePath: "/nix/store/aaa-node" },
      recencyRootsDir,
      projectKey: "npm-deadbeef=",
      run,
    });

    expect(links).toHaveLength(1);
    expect(links.every((l) => existsSync(l))).toBe(true);
  });

  it("prunes the roots whose project key falls outside the warm budget, keeping the rest", () => {
    const recencyRootsDir = mkdtempSync(join(tmpdir(), "dustcastle-recency-roots-"));
    tmps.push(recencyRootsDir);
    const run = (args: readonly string[]): NixResult => {
      if (args[1] === "--add-root") writeFileSync(args[2]!, "");
      return OK();
    };
    for (const key of ["npm-warm=", "npm-cold="]) {
      registerRecencyRoot({
        provisioned: { toolchainStorePath: `/nix/store/${key}-tc` },
        recencyRootsDir,
        projectKey: key,
        run,
      });
    }

    const { pruned } = pruneRecencyRoots({ recencyRootsDir, keepKeys: ["npm-warm="] });

    expect(pruned).toBe(1); // only the cold root removed
    expect(existsSync(gcRootLink(recencyRootsDir, "npm-warm=", "toolchain"))).toBe(true);
    expect(existsSync(gcRootLink(recencyRootsDir, "npm-cold=", "toolchain"))).toBe(false);
  });

  it("prunes nothing when the recency-roots dir does not exist (best-effort)", () => {
    expect(pruneRecencyRoots({ recencyRootsDir: join(tmpdir(), "dustcastle-no-such-dir-xyz"), keepKeys: [] })).toEqual({
      pruned: 0,
    });
  });
});
