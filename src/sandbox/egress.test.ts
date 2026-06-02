import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageManager } from "../ecosystems/index.js";
import { deriveEgress, egressHosts, gitRemoteHost, parseGitRemoteHost } from "./egress.js";

// Standing egress (ADR 0005 / 0010 / 0012). Egress is a STANDING allowlist that no
// longer branches on build purity: every Sandbox installs deps with the network on,
// so the registry + git are always present. It is the union of each DETECTED Package
// Manager's registry host (the install runs in-Sandbox via the sandcastle hook), the
// repo's git host, and the agent's model host(s). A polyglot repo opens every detected
// registry. The derivation is pure — pinned here.

describe("deriveEgress — standing allowlist (ADR 0012, no per-purity derivation)", () => {
  it("unions a single manager's registry with the git and model hosts", () => {
    const decision = deriveEgress({
      packageManagers: ["npm"],
      gitRemoteHost: "github.com",
      agentModelHosts: ["api.deepseek.com"],
    });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["registry.npmjs.org", "github.com"]);
    expect(decision.agentHosts).toEqual(["api.deepseek.com"]);
  });

  it("opens only the npm registry for an npm/pnpm/bun repo", () => {
    const managers: PackageManager[] = ["npm", "pnpm", "bun"];
    for (const pm of managers) {
      const decision = deriveEgress({ packageManagers: [pm] });
      if (decision.kind !== "allowlist") throw new Error("unreachable");
      expect(decision.buildHosts).toContain("registry.npmjs.org");
      expect(decision.agentHosts).toEqual([]);
    }
  });

  it("opens the yarn registry for a yarn repo", () => {
    const decision = deriveEgress({ packageManagers: ["yarn"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("registry.yarnpkg.com");
  });

  it("opens pypi.org for a pip/uv/poetry repo", () => {
    const managers: PackageManager[] = ["pip", "uv", "poetry"];
    for (const pm of managers) {
      const decision = deriveEgress({ packageManagers: [pm] });
      if (decision.kind !== "allowlist") throw new Error("unreachable");
      expect(decision.buildHosts).toContain("pypi.org");
    }
  });

  it("opens the Go module proxy for a go repo (go gained a required registryHost)", () => {
    const decision = deriveEgress({ packageManagers: ["go"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("proxy.golang.org");
  });

  it("opens the crates index for a cargo repo (cargo gained a required registryHost)", () => {
    const decision = deriveEgress({ packageManagers: ["cargo"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("index.crates.io");
  });

  it("yields BOTH registries for a polyglot Node + Python repo (the union)", () => {
    const decision = deriveEgress({ packageManagers: ["npm", "uv"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("registry.npmjs.org");
    expect(decision.buildHosts).toContain("pypi.org");
  });

  it("dedupes a shared registry across detected managers (Node + Node)", () => {
    // npm and pnpm both name registry.npmjs.org — the union lists it once.
    const decision = deriveEgress({ packageManagers: ["npm", "pnpm"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["registry.npmjs.org"]);
  });

  it("adds the repo's git host to Build Egress when known (git-sourced deps resolve)", () => {
    const decision = deriveEgress({ packageManagers: ["npm"], gitRemoteHost: "github.com" });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("registry.npmjs.org");
    expect(decision.buildHosts).toContain("github.com");
  });

  it("is an allowlist, never unrestricted — no wildcard / catch-all host", () => {
    const decision = deriveEgress({ packageManagers: ["npm"], gitRemoteHost: "github.com" });
    const hosts = egressHosts(decision);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host).not.toMatch(/[*]|0\.0\.0\.0\/0|^all$/);
    }
  });

  it("closes egress (`none`) only when no manager is detected and no agent runs", () => {
    expect(deriveEgress({ packageManagers: [] })).toEqual({ kind: "none" });
    expect(deriveEgress({ packageManagers: [], agentModelHosts: [] })).toEqual({ kind: "none" });
    expect(deriveEgress({ packageManagers: [], agentModelHosts: [""] })).toEqual({ kind: "none" });
  });

  it("opens an agent-only allowlist when no manager is detected but an agent runs", () => {
    const decision = deriveEgress({ packageManagers: [], agentModelHosts: ["api.deepseek.com"] });
    expect(decision).toEqual({ kind: "allowlist", buildHosts: [], agentHosts: ["api.deepseek.com"] });
  });

  it("carries every host a multi-host provider may contact", () => {
    const decision = deriveEgress({
      packageManagers: ["go"],
      agentModelHosts: ["chatgpt.com", "auth.openai.com"],
    });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.agentHosts).toEqual(["chatgpt.com", "auth.openai.com"]);
  });

  it("ignores empty agent hosts (no agent ⇒ no agent egress)", () => {
    const decision = deriveEgress({ packageManagers: ["npm"], agentModelHosts: ["", "api.deepseek.com"] });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.agentHosts).toEqual(["api.deepseek.com"]);
  });
});

describe("egressHosts (the deduped union the proxy enforces)", () => {
  it("returns Build hosts first, then Agent hosts", () => {
    const decision = deriveEgress({
      packageManagers: ["npm"],
      gitRemoteHost: "github.com",
      agentModelHosts: ["api.deepseek.com"],
    });
    expect(egressHosts(decision)).toEqual(["registry.npmjs.org", "github.com", "api.deepseek.com"]);
  });

  it("dedupes a host that is both a build and an agent host", () => {
    const decision = { kind: "allowlist", buildHosts: ["api.deepseek.com"], agentHosts: ["api.deepseek.com"] } as const;
    expect(egressHosts(decision)).toEqual(["api.deepseek.com"]);
  });

  it("is empty for a closed decision", () => {
    expect(egressHosts({ kind: "none" })).toEqual([]);
  });
});

describe("parseGitRemoteHost (read the host from a remote URL)", () => {
  it("parses an scp-style ssh remote", () => {
    expect(parseGitRemoteHost("git@github.com:org/repo.git")).toBe("github.com");
  });

  it("parses an https remote, dropping any port", () => {
    expect(parseGitRemoteHost("https://gitlab.example.com:8443/team/repo.git")).toBe(
      "gitlab.example.com",
    );
  });

  it("parses an ssh:// remote", () => {
    expect(parseGitRemoteHost("ssh://git@bitbucket.org/team/repo.git")).toBe("bitbucket.org");
  });

  it("returns undefined for an unrecognized / empty remote", () => {
    expect(parseGitRemoteHost("")).toBeUndefined();
    expect(parseGitRemoteHost("not a url")).toBeUndefined();
  });
});

describe("gitRemoteHost (egress allowlist input)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-egress-git-"));
    tmps.push(dir);
    execFileSync("git", ["-C", dir, "init", "-q"]);
    return dir;
  };

  it("reads origin's host from a real repo", () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:org/repo.git"]);
    expect(gitRemoteHost(dir)).toBe("github.com");
  });

  it("returns undefined when there is no remote", () => {
    expect(gitRemoteHost(repo())).toBeUndefined();
  });
});
