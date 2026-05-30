import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../detect/index.js";
import { provisionStore } from "./index.js";

// The store dispatch (slice 2b): which importer a detection routes to, and how
// unbuilt importers are gated. These cases throw inside the `switch` before any
// nix-portable build runs, so they need no toolchain — they pin the routing
// contract and the honest bun gate. The live builds are proven by the gated e2e.

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

function stagedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "dustcastle-store-dispatch-"));
  tmps.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}

const provision = (detection: Detection) =>
  provisionStore({
    projectDir: stagedProject(),
    detection,
    // A bogus nix-portable path is fine: the cases under test throw before `run`.
    nixPortable: "/nonexistent/nix-portable",
  });

describe("provisionStore dispatch (slice 2b importer routing)", () => {
  it("gates bun explicitly: nixpkgs has no canonical bun importer yet", () => {
    expect(() =>
      provision({ ecosystem: "node", packageManager: "bun", importer: "fetchBunDeps" }),
    ).toThrowError(/bun importer is not yet supported/);
  });

  it("rejects an unknown importer with a clear, listing error", () => {
    expect(() =>
      provision({ ecosystem: "node", packageManager: "mystery", importer: "fetchMysteryDeps" }),
    ).toThrowError(/unsupported importer fetchMysteryDeps/);
  });
});
