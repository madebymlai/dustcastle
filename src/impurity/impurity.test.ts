import { describe, expect, it } from "vitest";
import {
  decideImpurity,
  parseImpurityMode,
  impurityMarkerJson,
  npmLockNeedsImpurity,
  pnpmLockNeedsImpurity,
  type ImpurityContext,
} from "./index.js";

// The impurity policy (ADR 0004): `impure = allow | ask | deny`, and the
// invariant it protects is "you always know whether a Sandbox is reproducible" —
// impurity is permitted but NEVER silent. The decision function is pure, so we
// pin it hard here; the env-sourcing and marker shape live alongside it.

const base: ImpurityContext = {
  mode: "allow",
  impurityNeeded: true,
  headless: false,
  ecosystem: "node",
  packageManager: "npm",
  lockfileHash: "sha256-deadbeef",
};

describe("parseImpurityMode (ADR 0005 config-less: sourced from env)", () => {
  it("defaults to allow — the solo/own-repos flow (ADR 0004)", () => {
    expect(parseImpurityMode({})).toBe("allow");
  });

  it("reads allow/ask/deny from DUSTCASTLE_IMPURE, case-insensitively", () => {
    expect(parseImpurityMode({ DUSTCASTLE_IMPURE: "ask" })).toBe("ask");
    expect(parseImpurityMode({ DUSTCASTLE_IMPURE: "DENY" })).toBe("deny");
    expect(parseImpurityMode({ DUSTCASTLE_IMPURE: "Allow" })).toBe("allow");
  });

  it("rejects an unknown mode with an actionable error (never silently default)", () => {
    expect(() => parseImpurityMode({ DUSTCASTLE_IMPURE: "yolo" })).toThrow(/allow|ask|deny/);
  });
});

describe("decideImpurity (ADR 0004 state machine)", () => {
  it("is pure when no impurity is needed — even under deny (the policy never fires)", () => {
    // A clean lockfile builds offline; the policy is irrelevant. This is the
    // common path and must not depend on the mode at all.
    for (const mode of ["allow", "ask", "deny"] as const) {
      expect(decideImpurity({ ...base, mode, impurityNeeded: false })).toEqual({ kind: "pure" });
    }
  });

  it("allow: builds impurely AND emits a marker (async consent, not silent)", () => {
    const decision = decideImpurity({ ...base, mode: "allow" });
    expect(decision.kind).toBe("impure");
    if (decision.kind !== "impure") throw new Error("unreachable");
    // The marker is the whole point: it carries the lockfile identity so the
    // impure build surfaces in git status / the PR diff.
    expect(decision.marker).toMatchObject({
      ecosystem: "node",
      packageManager: "npm",
      lockfileHash: "sha256-deadbeef",
    });
  });

  it("deny: exits with an actionable reason (the strict stance)", () => {
    const decision = decideImpurity({ ...base, mode: "deny" });
    expect(decision.kind).toBe("deny");
    if (decision.kind !== "deny") throw new Error("unreachable");
    expect(decision.reason).toMatch(/impur/i);
  });

  it("ask + interactive + no prior answer: asks once (caller prompts)", () => {
    const decision = decideImpurity({ ...base, mode: "ask" });
    expect(decision).toEqual({ kind: "ask", lockfileHash: "sha256-deadbeef" });
  });

  it("ask: a cached yes for this lockfile hash builds impurely without re-asking", () => {
    const decision = decideImpurity({ ...base, mode: "ask", priorConsent: true });
    expect(decision.kind).toBe("impure");
  });

  it("ask: a cached no for this lockfile hash denies", () => {
    const decision = decideImpurity({ ...base, mode: "ask", priorConsent: false });
    expect(decision.kind).toBe("deny");
  });

  it("ask + headless: NEVER asks — falls back decisively so an agent can't stall", () => {
    // The headless fallback is the load-bearing rule: a blocking prompt must
    // never stall an unattended agent (ADR 0004). Default fallback is deny.
    const denyByDefault = decideImpurity({ ...base, mode: "ask", headless: true });
    expect(denyByDefault.kind).toBe("deny");

    // ...but the fallback is configurable (ADR 0004 "a configured default").
    const allowConfigured = decideImpurity({
      ...base,
      mode: "ask",
      headless: true,
      headlessFallback: "allow",
    });
    expect(allowConfigured.kind).toBe("impure");
  });
});

describe("npmLockNeedsImpurity (detect impurity from the lockfile, not a failed build)", () => {
  // nix-portable enforces no build sandbox, so we can't learn "impurity needed"
  // by watching a pure build fail offline. Instead we read it straight from the
  // npm lockfile: a package with an install/postinstall script (`hasInstallScript`)
  // is exactly what the pure --ignore-scripts provision can't satisfy.
  it("flags a lockfile that contains an install-scripted dependency", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": { name: "app" },
        "node_modules/esbuild": { version: "0.21.0", hasInstallScript: true },
        "node_modules/lodash": { version: "4.17.21" },
      },
    };
    expect(npmLockNeedsImpurity(lock)).toBe(true);
  });

  it("treats a lockfile with no install scripts as pure (the common case)", () => {
    const lock = {
      lockfileVersion: 3,
      packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.21" } },
    };
    expect(npmLockNeedsImpurity(lock)).toBe(false);
  });

  it("is pure for a trivially empty or malformed lockfile (no scripts to run)", () => {
    expect(npmLockNeedsImpurity({})).toBe(false);
    expect(npmLockNeedsImpurity(null)).toBe(false);
    expect(npmLockNeedsImpurity("garbage")).toBe(false);
  });
});

describe("pnpmLockNeedsImpurity (the pnpm-lock.yaml install-script signal)", () => {
  // pnpm-lock.yaml has no `hasInstallScript`; its equivalent is `requiresBuild: true`
  // on a package's metadata entry (a dep with install/postinstall scripts or native
  // build). It's YAML, not JSON, and ADR 0001 forbids a heavyweight parser, so we
  // scan it as text (mirroring the owned pnpm-workspace.yaml parser in workspace.ts).
  it("flags a v9 lockfile whose package entry requiresBuild", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  esbuild@0.21.0:",
      "    resolution: {integrity: sha512-deadbeef}",
      "    engines: {node: '>=12'}",
      "    hasBin: true",
      "    requiresBuild: true",
      "",
      "  is-number@7.0.0:",
      "    resolution: {integrity: sha512-cafe}",
      "",
    ].join("\n");
    expect(pnpmLockNeedsImpurity(lock)).toBe(true);
  });

  it("treats a lockfile with no requiresBuild flag as pure (the common case)", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  is-number@7.0.0:",
      "    resolution: {integrity: sha512-cafe}",
      "    engines: {node: '>=0.12.0'}",
      "",
    ].join("\n");
    expect(pnpmLockNeedsImpurity(lock)).toBe(false);
  });

  it("is pure for empty / non-string input (nothing to build)", () => {
    expect(pnpmLockNeedsImpurity("")).toBe(false);
    expect(pnpmLockNeedsImpurity(undefined)).toBe(false);
    expect(pnpmLockNeedsImpurity({ packages: {} })).toBe(false);
  });

  it("does not match a stray non-key occurrence of the word", () => {
    // A bare/top-level mention must not trip the gate — only a real indented YAML key does.
    expect(pnpmLockNeedsImpurity("# requiresBuild: true (a comment)\nrequiresBuild: true")).toBe(false);
  });
});

describe("impurityMarkerJson (the visible, version-controlled marker)", () => {
  it("serializes the marker deterministically (stable diff in git)", () => {
    const marker = { ecosystem: "node", packageManager: "npm", lockfileHash: "sha256-abc" };
    expect(impurityMarkerJson(marker)).toBe(impurityMarkerJson(marker));
    expect(JSON.parse(impurityMarkerJson(marker))).toMatchObject(marker);
  });
});
