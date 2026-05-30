import { describe, expect, it } from "vitest";
import { exportRequirements, lockOnlyResolve, pinLooseManifest, type ResolveResult } from "./pin.js";

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

  it("resolves a loose pip manifest with `uv pip compile --generate-hashes` (laimk-hse.5)", () => {
    // A loose Python manifest (unpinned/hash-less requirements.txt, abstract
    // pyproject) resolves ONCE into a VISIBLE, hash-pinned requirements.txt, then
    // builds pure via the pip-FOD (ADR 0006c amendment). uv is a pure export
    // front-end, not a separate Importer.
    const resolve = lockOnlyResolve("pip");
    expect(resolve.command).toBe("uv");
    expect(resolve.args).toEqual(["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"]);
    expect(resolve.lockfile).toBe("requirements.txt");
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

  it("runs the pip loose resolve (uv pip compile) and surfaces the generated requirements.txt", () => {
    // The Python pin-then-pure path (laimk-hse.5): the one-time online resolve runs
    // `uv pip compile --generate-hashes`, producing the VISIBLE, committed lock.
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run = (command: string, args: readonly string[], cwd: string): ResolveResult => {
      calls.push({ command, args, cwd });
      return OK;
    };

    const pinned = pinLooseManifest({ cwd: "/py", packageManager: "pip", run });

    expect(calls).toEqual([
      { command: "uv", args: ["pip", "compile", "--generate-hashes", "requirements.in", "-o", "requirements.txt"], cwd: "/py" },
    ]);
    expect(pinned.lockfile).toBe("requirements.txt");
  });
});

describe("exportRequirements (the export front-end — ADR 0006 amendment)", () => {
  it("runs `uv export` to materialise requirements.txt from uv.lock before provisioning", () => {
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run = (command: string, args: readonly string[], cwd: string): ResolveResult => {
      calls.push({ command, args, cwd });
      return OK;
    };

    const exported = exportRequirements({ cwd: "/uvproj", packageManager: "uv", run });

    expect(calls).toEqual([
      { command: "uv", args: ["export", "--format", "requirements-txt", "-o", "requirements.txt"], cwd: "/uvproj" },
    ]);
    expect(exported?.requirementsFile).toBe("requirements.txt");
  });

  it("is a no-op for pip — it consumes requirements.txt directly (no front-end)", () => {
    let called = false;
    const run = (): ResolveResult => {
      called = true;
      return OK;
    };
    expect(exportRequirements({ cwd: "/py", packageManager: "pip", run })).toBeUndefined();
    expect(called).toBe(false);
  });

  it("runs `poetry export` to materialise requirements.txt from poetry.lock (laimk-hse.7)", () => {
    // poetry was gated until the spike proved `poetry export` hermetic; it now runs
    // the front-end like uv. Hashes are ON by default, so no `--without-hashes` flag.
    const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
    const run = (command: string, args: readonly string[], cwd: string): ResolveResult => {
      calls.push({ command, args, cwd });
      return OK;
    };

    const exported = exportRequirements({ cwd: "/po", packageManager: "poetry", run });

    expect(calls).toEqual([
      { command: "poetry", args: ["export", "--format", "requirements.txt", "-o", "requirements.txt"], cwd: "/po" },
    ]);
    expect(exported?.requirementsFile).toBe("requirements.txt");
  });

  it("throws an actionable error when the export fails (no un-materialised build proceeds)", () => {
    const run = (): ResolveResult => ({ status: 1, stderr: "error: No `uv.lock` found" });
    expect(() => exportRequirements({ cwd: "/uvproj", packageManager: "uv", run })).toThrow(/front-end failed/i);
  });
});
