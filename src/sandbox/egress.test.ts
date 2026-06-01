import { describe, expect, it } from "vitest";
import { deriveEgress, egressHosts, parseGitRemoteHost } from "./egress.js";

// Scoped egress (ADR 0005 / 0010). Egress is the union of two sources: Build Egress
// (the registry + git host an *impure* build needs, derived from detection) and
// Agent Egress (the *agent's* model-provider host, present whenever an agent runs,
// regardless of build purity). A pure build with no agent reaches nothing. The
// derivation is pure — pinned here.

describe("deriveEgress — Build Egress (ADR 0005 derived allowlist)", () => {
  it("closes egress entirely for a pure build with no agent — no network at all", () => {
    for (const packageManager of ["npm", "pnpm", "yarn", "go", "cargo"]) {
      expect(deriveEgress({ packageManager, impure: false })).toEqual({ kind: "none" });
    }
  });

  it("allows only the npm registry for an impure npm/pnpm/bun build", () => {
    for (const packageManager of ["npm", "pnpm", "bun"]) {
      const decision = deriveEgress({ packageManager, impure: true });
      expect(decision.kind).toBe("allowlist");
      if (decision.kind !== "allowlist") throw new Error("unreachable");
      expect(decision.buildHosts).toContain("registry.npmjs.org");
      expect(decision.agentHosts).toEqual([]);
    }
  });

  it("allows the yarn registry for an impure yarn build", () => {
    const decision = deriveEgress({ packageManager: "yarn", impure: true });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("registry.yarnpkg.com");
  });

  it("adds the repo's git host to Build Egress when known (git deps resolve)", () => {
    const decision = deriveEgress({ packageManager: "npm", impure: true, gitRemoteHost: "github.com" });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toContain("registry.npmjs.org");
    expect(decision.buildHosts).toContain("github.com");
  });

  it("derives Cargo vendor egress from sparse crates.io plus manifest git dependency hosts only", () => {
    const decision = deriveEgress({
      packageManager: "cargo",
      impure: false,
      buildPhase: "cargo-vendor",
      cargoManifest: `
[dependencies]
itoa = { git = "https://github.com/dtolnay/itoa", tag = "1.0.15" }
serde = "1"
`,
    });

    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["index.crates.io", "static.crates.io", "github.com:443"]);
    expect(decision.buildHosts).not.toContain("github.com/rust-lang/crates.io-index");
    expect(decision.buildHosts).not.toContain("crates.io");
  });

  it("does not add any git host to Cargo vendor egress when the manifest has no git dependency", () => {
    const decision = deriveEgress({
      packageManager: "cargo",
      impure: false,
      buildPhase: "cargo-vendor",
      cargoManifest: `
[dependencies]
serde = "1"
# git = "https://github.com/commented/out"
`,
    });

    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["index.crates.io", "static.crates.io"]);
  });

  it("allows only the crates.io sparse index for a cargo lock-only resolve", () => {
    const decision = deriveEgress({ packageManager: "cargo", impure: false, buildPhase: "lockOnlyResolve" });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["index.crates.io"]);
    expect(decision.buildHosts).not.toContain("static.crates.io");
    expect(decision.agentHosts).toEqual([]);
  });

  it("is an allowlist, never unrestricted — no wildcard / catch-all host", () => {
    const decision = deriveEgress({ packageManager: "npm", impure: true, gitRemoteHost: "github.com" });
    const hosts = egressHosts(decision);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host).not.toMatch(/[*]|0\.0\.0\.0\/0|^all$/);
    }
  });
});

describe("deriveEgress — Agent Egress (ADR 0010 model-host carve-out)", () => {
  it("opens an allowlist with ONLY the agent host on a pure build (no build egress)", () => {
    // The carve-out: a pure, offline build still lets the in-sandbox agent reach
    // its LLM. The build itself gains no registry/git host.
    const decision = deriveEgress({ packageManager: "npm", impure: false, agentModelHosts: ["api.deepseek.com"] });
    expect(decision).toEqual({ kind: "allowlist", buildHosts: [], agentHosts: ["api.deepseek.com"] });
  });

  it("carries every host a multi-host provider may contact", () => {
    // A provider can span several endpoints (auth refresh, regional); all are
    // allowlisted so the agent's actual host is always covered.
    const decision = deriveEgress({
      packageManager: "go",
      impure: false,
      agentModelHosts: ["chatgpt.com", "auth.openai.com"],
    });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.agentHosts).toEqual(["chatgpt.com", "auth.openai.com"]);
  });

  it("unions Build and Agent Egress on an impure build", () => {
    const decision = deriveEgress({
      packageManager: "npm",
      impure: true,
      gitRemoteHost: "github.com",
      agentModelHosts: ["api.deepseek.com"],
    });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.buildHosts).toEqual(["registry.npmjs.org", "github.com"]);
    expect(decision.agentHosts).toEqual(["api.deepseek.com"]);
  });

  it("ignores empty agent hosts (no agent ⇒ no agent egress)", () => {
    expect(deriveEgress({ packageManager: "npm", impure: false, agentModelHosts: [] })).toEqual({ kind: "none" });
    expect(deriveEgress({ packageManager: "npm", impure: false, agentModelHosts: [""] })).toEqual({ kind: "none" });
  });
});

describe("egressHosts (the deduped union the proxy enforces)", () => {
  it("returns Build hosts first, then Agent hosts", () => {
    const decision = deriveEgress({
      packageManager: "npm",
      impure: true,
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
