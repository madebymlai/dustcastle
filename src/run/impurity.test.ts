import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import {
  gitRemoteHost,
  MARKER_PATH,
  parseYesNo,
  pendingImpurityAsk,
  resolveImpurity,
  writeImpurityMarker,
} from "./impurity.js";

// The run-layer glue between the lockfile, the pure impurity state machine, and
// the marker file (ADR 0004). Exercised against real throwaway directories — no
// Nix, no podman — so it stays in the fast unit suite.

const tmps: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-impurity-"));
  tmps.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const node: Detection = { ecosystem: "node", packageManager: "npm" };
const pnpm: Detection = { ecosystem: "node", packageManager: "pnpm" };
const yarn: Detection = { ecosystem: "node", packageManager: "yarn" };
const go: Detection = { ecosystem: "go", packageManager: "go" };
const pip: Detection = { ecosystem: "python", packageManager: "pip" };

const cleanLock = JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" } } });
const scriptedLock = JSON.stringify({
  lockfileVersion: 3,
  packages: { "": { name: "app" }, "node_modules/esbuild": { hasInstallScript: true } },
});

const cleanPnpmLock = "lockfileVersion: '9.0'\n\npackages:\n\n  is-number@7.0.0:\n    resolution: {integrity: sha512-cafe}\n";
const scriptedPnpmLock =
  "lockfileVersion: '9.0'\n\npackages:\n\n  esbuild@0.21.0:\n    resolution: {integrity: sha512-beef}\n    requiresBuild: true\n";

describe("resolveImpurity (run-layer policy glue)", () => {
  it("is always pure for a manager with no impuritySignal (Go never has impure installs)", () => {
    const dir = repo({});
    const decision = resolveImpurity({ cwd: dir, detection: go, mode: "deny", headless: true, env: {} });
    expect(decision).toEqual({ kind: "pure" });
  });

  it("routes a Python pip project through the impurity gate (requirements.txt is conservative-pure)", () => {
    // pip carries an impuritySignal over requirements.txt (laimk-hse.4), so a
    // Python project flows through the decision machine rather than being skipped.
    // The static signal is conservative-pure; --only-binary=:all: keeps the FOD
    // honest at build time (an sdist-only dep hard-fails and surfaces).
    const dir = repo({ "requirements.txt": "idna==3.7 --hash=sha256:aaa" });
    const decision = resolveImpurity({ cwd: dir, detection: pip, mode: "deny", headless: true, env: {} });
    expect(decision.kind).toBe("pure");
  });

  it("is pure for a Node project whose lockfile has no install scripts", () => {
    const dir = repo({ "package-lock.json": cleanLock });
    const decision = resolveImpurity({ cwd: dir, detection: node, mode: "allow", headless: true, env: {} });
    expect(decision.kind).toBe("pure");
  });

  it("goes impure (with a marker) for a scripted lockfile under allow", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const decision = resolveImpurity({ cwd: dir, detection: node, mode: "allow", headless: true, env: {} });
    expect(decision.kind).toBe("impure");
    if (decision.kind !== "impure") throw new Error("unreachable");
    expect(decision.marker.packageManager).toBe("npm");
    // The marker key is the lockfile hash, so a content change re-triggers consent.
    expect(decision.marker.lockfileHash).toMatch(/^sha256-/);
  });

  it("reads the pnpm lockfile signal: requiresBuild → impure under allow", () => {
    const dir = repo({ "pnpm-lock.yaml": scriptedPnpmLock });
    const decision = resolveImpurity({ cwd: dir, detection: pnpm, mode: "allow", headless: true, env: {} });
    expect(decision.kind).toBe("impure");
    if (decision.kind !== "impure") throw new Error("unreachable");
    expect(decision.marker.packageManager).toBe("pnpm");
    // The marker keys off the pnpm-lock.yaml content, not package-lock.json.
    expect(decision.marker.lockfileHash).toMatch(/^sha256-/);
  });

  it("is pure for a pnpm project whose lockfile has no requiresBuild flag", () => {
    const dir = repo({ "pnpm-lock.yaml": cleanPnpmLock });
    const decision = resolveImpurity({ cwd: dir, detection: pnpm, mode: "allow", headless: true, env: {} });
    expect(decision.kind).toBe("pure");
  });

  it("resolves a yarn project pure: yarn.lock carries no install-script signal (documented contract)", () => {
    // yarn.lock (v1) has only version/resolved/integrity/dependencies — no
    // hasInstallScript/requiresBuild equivalent (that lives in package.json#
    // dependenciesMeta / .yarnrc). So even a project with a build-needing dep
    // resolves pure: the pure yarnConfigHook provision never runs scripts.
    const yarnLock =
      "# yarn lockfile v1\n\nesbuild@^0.21.0:\n  version \"0.21.0\"\n  resolved \"https://registry.yarnpkg.com/esbuild/-/esbuild-0.21.0.tgz\"\n";
    const dir = repo({ "yarn.lock": yarnLock });
    const decision = resolveImpurity({ cwd: dir, detection: yarn, mode: "allow", headless: true, env: {} });
    expect(decision.kind).toBe("pure");
  });

  it("denies a scripted lockfile under deny", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const decision = resolveImpurity({ cwd: dir, detection: node, mode: "deny", headless: true, env: {} });
    expect(decision.kind).toBe("deny");
  });

  it("ask + headless: never stalls — denies by default", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const decision = resolveImpurity({ cwd: dir, detection: node, mode: "ask", headless: true, env: {} });
    expect(decision.kind).toBe("deny");
  });

  it("ask + headless honors DUSTCASTLE_IMPURE_HEADLESS=allow", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const decision = resolveImpurity({
      cwd: dir,
      detection: node,
      mode: "ask",
      headless: true,
      env: { DUSTCASTLE_IMPURE_HEADLESS: "allow" },
    });
    expect(decision.kind).toBe("impure");
  });

  it("ask: a recorded marker for this lockfile is cached consent (no re-ask)", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    // First, an interactive ask would prompt...
    const first = resolveImpurity({ cwd: dir, detection: node, mode: "ask", headless: false, env: {} });
    expect(first.kind).toBe("ask");
    // ...record consent via the marker, then the same lockfile builds impurely.
    if (first.kind !== "ask") throw new Error("unreachable");
    writeImpurityMarker(dir, {
      ecosystem: "node",
      packageManager: "npm",
      lockfileHash: first.lockfileHash,
    });
    const second = resolveImpurity({ cwd: dir, detection: node, mode: "ask", headless: false, env: {} });
    expect(second.kind).toBe("impure");
  });
});

describe("pendingImpurityAsk (the interactive CLI gate — ADR 0004)", () => {
  it("surfaces a pending question for a scripted lockfile under ask (no prior consent)", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const ask = pendingImpurityAsk({ cwd: dir, detection: node, mode: "ask", env: {} });
    expect(ask).toBeDefined();
    expect(ask!.marker.packageManager).toBe("npm");
    expect(ask!.marker.lockfileHash).toMatch(/^sha256-/);
    expect(ask!.lockfileHash).toBe(ask!.marker.lockfileHash);
    expect(ask!.prompt).toMatch(/impure/i);
  });

  it("surfaces a pending question for a pnpm requiresBuild lockfile under ask", () => {
    const dir = repo({ "pnpm-lock.yaml": scriptedPnpmLock });
    const ask = pendingImpurityAsk({ cwd: dir, detection: pnpm, mode: "ask", env: {} });
    expect(ask).toBeDefined();
    expect(ask!.marker.packageManager).toBe("pnpm");
    expect(ask!.prompt).toMatch(/pnpm/);
  });

  it("does not prompt when the build is already pure (clean lockfile)", () => {
    const dir = repo({ "package-lock.json": cleanLock });
    expect(pendingImpurityAsk({ cwd: dir, detection: node, mode: "ask", env: {} })).toBeUndefined();
  });

  it("does not prompt under allow (the policy resolves without a human)", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    expect(pendingImpurityAsk({ cwd: dir, detection: node, mode: "allow", env: {} })).toBeUndefined();
  });

  it("does not prompt once consent is cached for this lockfile", () => {
    const dir = repo({ "package-lock.json": scriptedLock });
    const ask = pendingImpurityAsk({ cwd: dir, detection: node, mode: "ask", env: {} });
    expect(ask).toBeDefined();
    writeImpurityMarker(dir, ask!.marker);
    expect(pendingImpurityAsk({ cwd: dir, detection: node, mode: "ask", env: {} })).toBeUndefined();
  });

  it("never prompts for a pure ecosystem (Go)", () => {
    const dir = repo({});
    expect(pendingImpurityAsk({ cwd: dir, detection: go, mode: "ask", env: {} })).toBeUndefined();
  });
});

describe("parseYesNo (the y/n answer parser)", () => {
  it("accepts y / yes case- and whitespace-insensitively", () => {
    for (const yes of ["y", "Y", "yes", "YES", "  yes  ", "Yes"]) {
      expect(parseYesNo(yes)).toBe(true);
    }
  });

  it("treats anything else (incl. empty) as no — the safe default", () => {
    for (const no of ["", " ", "n", "N", "no", "nope", "maybe", "1"]) {
      expect(parseYesNo(no)).toBe(false);
    }
  });
});

describe("writeImpurityMarker (the visible, version-controlled record)", () => {
  it("writes a parseable .dustcastle/impure.json", () => {
    const dir = repo({});
    writeImpurityMarker(dir, { ecosystem: "node", packageManager: "npm", lockfileHash: "sha256-x" });
    const path = join(dir, MARKER_PATH);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ packageManager: "npm" });
  });
});

describe("gitRemoteHost (egress allowlist input)", () => {
  it("reads origin's host from a real repo", () => {
    const dir = repo({});
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:org/repo.git"]);
    expect(gitRemoteHost(dir)).toBe("github.com");
  });

  it("returns undefined when there is no remote", () => {
    const dir = repo({});
    execFileSync("git", ["-C", dir, "init", "-q"]);
    expect(gitRemoteHost(dir)).toBeUndefined();
  });
});
