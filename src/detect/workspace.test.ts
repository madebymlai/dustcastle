import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspace, workspaceMembers } from "./workspace.js";

// Per-workspace monorepo detection (ADR 0006d): a workspace root
// (pnpm-workspace.yaml, or package.json#workspaces for npm/yarn) enumerates its
// members and dustcastle provisions EACH. The glob enumeration is pure/unit-
// testable against a real throwaway tree; the live provision is a gated e2e.

const tmps: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdirSync(join(tmpdir(), `dustcastle-ws-${process.hrtime.bigint()}`), { recursive: true })!;
  const dir = root;
  tmps.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const PKG = JSON.stringify({ name: "m" });

describe("workspaceMembers (ADR 0006d glob enumeration)", () => {
  it("enumerates direct children of a pnpm-workspace `packages/*` glob", () => {
    const root = tree({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": PKG,
      "packages/b/package.json": PKG,
    });

    expect(workspaceMembers(root).sort()).toEqual([join(root, "packages/a"), join(root, "packages/b")]);
  });

  it("enumerates an npm/yarn `package.json#workspaces` array", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "root", workspaces: ["apps/*"] }),
      "apps/web/package.json": PKG,
      "apps/api/package.json": PKG,
    });

    expect(workspaceMembers(root).sort()).toEqual([join(root, "apps/api"), join(root, "apps/web")]);
  });

  it("supports the yarn object form (`workspaces.packages`)", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["pkgs/*"] } }),
      "pkgs/one/package.json": PKG,
    });

    expect(workspaceMembers(root)).toEqual([join(root, "pkgs/one")]);
  });

  it("expands `**` recursively and honors `!` exclusions", () => {
    const root = tree({
      "pnpm-workspace.yaml": "packages:\n  - 'components/**'\n  - '!**/fixtures/**'\n",
      "components/a/package.json": PKG,
      "components/group/b/package.json": PKG,
      "components/group/fixtures/skip/package.json": PKG,
    });

    expect(workspaceMembers(root).sort()).toEqual([
      join(root, "components/a"),
      join(root, "components/group/b"),
    ]);
  });

  it("only counts member dirs that actually contain a package.json", () => {
    const root = tree({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/real/package.json": PKG,
      "packages/empty/README.md": "no manifest here",
    });

    expect(workspaceMembers(root)).toEqual([join(root, "packages/real")]);
  });

  it("returns no members for a non-workspace root", () => {
    const root = tree({ "package.json": PKG });
    expect(workspaceMembers(root)).toEqual([]);
  });
});

describe("detectWorkspace (the fan-out shape prepareRun provisions over)", () => {
  it("returns one project per member for a workspace root, each with its detection", () => {
    const root = tree({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": JSON.stringify({ name: "a" }),
      "packages/a/package-lock.json": "{}",
      "packages/b/package.json": JSON.stringify({ name: "b" }),
      "packages/b/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const ws = detectWorkspace(root);

    expect(ws.isWorkspace).toBe(true);
    expect(ws.projects.map((p) => p.dir).sort()).toEqual([join(root, "packages/a"), join(root, "packages/b")]);
    const a = ws.projects.find((p) => p.dir === join(root, "packages/a"));
    const b = ws.projects.find((p) => p.dir === join(root, "packages/b"));
    expect(a?.detections[0]?.packageManager).toBe("npm");
    expect(b?.detections[0]?.packageManager).toBe("pnpm");
  });

  it("falls back to the single root project when it is not a workspace", () => {
    const root = tree({ "package.json": PKG, "package-lock.json": "{}" });

    const ws = detectWorkspace(root);

    expect(ws.isWorkspace).toBe(false);
    expect(ws.projects).toHaveLength(1);
    expect(ws.projects[0]?.dir).toBe(root);
    expect(ws.projects[0]?.detections[0]?.ecosystem).toBe("node");
  });
});
