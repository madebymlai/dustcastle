import { describe, expect, it } from "vitest";
import { deriveEgress, parseGitRemoteHost } from "./egress.js";

// Scoped egress (ADR 0005). Pure builds reach no network at all; the impure
// `allow` path runs untrusted `postinstall` *with* network, so egress is an
// allowlist DERIVED from detection (the registry the manager already uses + the
// repo's git host), never unrestricted. The derivation is pure — pinned here.

describe("deriveEgress (ADR 0005 derived allowlist)", () => {
  it("closes egress entirely for a pure build — no network at all", () => {
    for (const packageManager of ["npm", "pnpm", "yarn", "go"]) {
      expect(deriveEgress({ packageManager, impure: false })).toEqual({ kind: "none" });
    }
  });

  it("allows only the npm registry for an impure npm/pnpm/bun build", () => {
    for (const packageManager of ["npm", "pnpm", "bun"]) {
      const decision = deriveEgress({ packageManager, impure: true });
      expect(decision.kind).toBe("allowlist");
      if (decision.kind !== "allowlist") throw new Error("unreachable");
      expect(decision.hosts).toContain("registry.npmjs.org");
    }
  });

  it("allows the yarn registry for an impure yarn build", () => {
    const decision = deriveEgress({ packageManager: "yarn", impure: true });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.hosts).toContain("registry.yarnpkg.com");
  });

  it("adds the repo's git host to the allowlist when known (git deps resolve)", () => {
    const decision = deriveEgress({ packageManager: "npm", impure: true, gitRemoteHost: "github.com" });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.hosts).toContain("registry.npmjs.org");
    expect(decision.hosts).toContain("github.com");
  });

  it("is an allowlist, never unrestricted — no wildcard / catch-all host", () => {
    const decision = deriveEgress({ packageManager: "npm", impure: true, gitRemoteHost: "github.com" });
    if (decision.kind !== "allowlist") throw new Error("unreachable");
    expect(decision.hosts.length).toBeGreaterThan(0);
    for (const host of decision.hosts) {
      expect(host).not.toMatch(/[*]|0\.0\.0\.0\/0|^all$/);
    }
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
