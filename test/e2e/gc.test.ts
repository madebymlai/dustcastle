import { existsSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detect } from "../../src/detect/index.js";
import { gcQueryArgs, nixPortableRunner, registerScopedRoots } from "../../src/store/gc.js";
import { provisionStore } from "../../src/store/index.js";
import { stageNodeProject } from "./fixture.js";

// 3b GATE (store lifecycle, ADR 0007): prove scoped GC roots protect a live run's
// closure, LIVE, through nix-portable. Deliberately NON-DESTRUCTIVE: it uses the
// `nix-store --gc --print-{dead,live}` dry-run rather than a real collect, so it
// never deletes paths the other e2e fixtures rely on in the shared warm store (the
// handoff's explicit warning). Asserts a rooted closure is reported LIVE (would be
// kept) and NOT dead (would not be collected), then released. Gated by DUSTCASTLE_E2E=1.
//
// The destructive `nix-store --gc` itself is unit-tested (command construction +
// report parsing); proving real deletion needs a dedicated scratch NP store (a
// capable-host follow-up) so the warm store's known-hash cache stays intact.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("scoped GC roots (ADR 0007 — protect an in-flight run's closure)", () => {
  e2e("roots the provisioned closure LIVE (would survive a sweep), then releases it", () => {
    const root = mkdtempSync(join(tmpdir(), "dustcastle-gc-e2e-"));
    tmps.push(root);
    const projectDir = stageNodeProject(root);
    const gcrootsDir = join(root, "gcroots");

    const detection = detect(projectDir)[0]!;
    const provisioned = provisionStore({ projectDir, detection });
    expect(provisioned.toolchainStorePath).toContain("/nix/store/");
    // ADR 0012: the Store holds only the Toolchain — no deps FOD path.

    const run = nixPortableRunner();

    const handle = registerScopedRoots({
      provisioned,
      gcrootsDir,
      projectKey: "npm-toolchain",
      run,
    });

    try {
      // ADR 0012: the closure is toolchain-only, so there is exactly ONE scoped root
      // (the toolchain) — the deps root is gone with the deps FOD.
      expect(handle.links).toHaveLength(1);
      for (const link of handle.links) {
        expect(existsSync(link)).toBe(true);
        expect(readlinkSync(link)).toContain("/nix/store/");
      }

      // LIVE proof: with the root in place, the toolchain path is reported as live
      // (a real sweep would KEEP it) and is NOT among the dead (collectable) paths.
      const live = run(gcQueryArgs("live"));
      const dead = run(gcQueryArgs("dead"));
      expect(live.status).toBe(0);
      expect(live.stdout).toContain(provisioned.toolchainStorePath);
      expect(dead.stdout).not.toContain(provisioned.toolchainStorePath);
    } finally {
      handle.release();
    }

    // Released: the scoped-root symlinks are gone (closure becomes collectable).
    expect(handle.links.some((l) => existsSync(l))).toBe(false);
  });
});
