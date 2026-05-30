import { describe, expect, it } from "vitest";
import { lockOnlyResolve, pinLooseManifest, type ResolveResult } from "./pin.js";

// Pin-then-pure (ADR 0006c): a loose manifest (a package.json with no lockfile)
// is resolved ONCE into a generated, committed lockfile, then every build runs
// pure/offline against it — strictly better than going impure. These tests pin
// the manager-specific lock-only resolve invocation (the pure decision); the real
// resolve + pure build is a gated e2e.

describe("lockOnlyResolve (the lock-only resolve invocation — ADR 0006c)", () => {
  it("resolves an npm loose manifest with `npm install --package-lock-only`", () => {
    const resolve = lockOnlyResolve("npm");
    expect(resolve.command).toBe("npm");
    expect(resolve.args).toEqual(["install", "--package-lock-only"]);
    expect(resolve.lockfile).toBe("package-lock.json");
  });

  it("resolves a pnpm loose manifest with `pnpm install --lockfile-only`", () => {
    const resolve = lockOnlyResolve("pnpm");
    expect(resolve.command).toBe("pnpm");
    expect(resolve.args).toEqual(["install", "--lockfile-only"]);
    expect(resolve.lockfile).toBe("pnpm-lock.yaml");
  });

  it("gates yarn with an actionable error (no clean lockfile-only resolve)", () => {
    // Yarn classic has no first-class lockfile-only resolve; rather than build it
    // wrong, dustcastle gates it honestly (the bun-gate pattern).
    expect(() => lockOnlyResolve("yarn")).toThrow(/yarn/i);
  });

  it("gates an unknown manager with an actionable error", () => {
    expect(() => lockOnlyResolve("bun")).toThrow(/pin-then-pure|loose manifest|lockfile/i);
  });
});

const OK: ResolveResult = { status: 0, stderr: "" };

describe("pinLooseManifest (the one-time online resolve — ADR 0006c)", () => {
  it("runs the lock-only resolve in the project dir and surfaces the generated lock", () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run = (command: string, args: readonly string[], cwd: string): ResolveResult => {
      calls.push({ command, args, cwd });
      return OK;
    };

    const pinned = pinLooseManifest({ cwd: "/proj", packageManager: "pnpm", run });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ command: "pnpm", args: ["install", "--lockfile-only"], cwd: "/proj" });
    expect(pinned.lockfile).toBe("pnpm-lock.yaml");
  });

  it("throws an actionable error when the resolve fails (no half-pinned build proceeds)", () => {
    const run = (): ResolveResult => ({ status: 1, stderr: "ENOTFOUND registry" });
    expect(() => pinLooseManifest({ cwd: "/proj", packageManager: "npm", run })).toThrow(
      /lock-only resolve failed/i,
    );
  });
});
