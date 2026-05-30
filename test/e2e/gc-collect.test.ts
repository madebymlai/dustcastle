import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectGarbage,
  gcQueryArgs,
  nixPortableRunner,
  registerRecencyRoot,
  registerScopedRoots,
} from "../../src/store/gc.js";
import { autoGc } from "../../src/store/autogc.js";
import { upsertRecency } from "../../src/store/recency.js";

// 3b GATE (DESTRUCTIVE, ADR 0007): prove a REAL `nix-store --gc` frees unrooted
// paths while a scoped-rooted path survives. The non-destructive sibling
// (gc.test.ts) proves root protection on the WARM store via --print-dead/live;
// this proves real DELETION — so it must NEVER touch the warm ~/.nix-portable,
// whose known-hash cache every other e2e fixture depends on. It runs against a
// DEDICATED SCRATCH nix-portable store (a fresh NP_LOCATION under the OS tmpdir);
// a hard guard refuses to sweep unless NP_LOCATION is a throwaway dir distinct
// from $HOME.
//
// It roots one already-present dead path rather than cold-building a closure: a
// fresh nix-portable store bootstraps with many collectable paths, so the proof
// needs no network build. (An earlier variant provisioned a full Node closure;
// the ~270s cold build blocked the worker event loop long enough to trip vitest's
// reporter RPC. Rooting an existing path is the same destructive proof in seconds.)
// Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  // A nix store holds read-only paths (dirs r-xr-xr-x), so a plain rmSync hits
  // EACCES (you can't unlink entries in a no-write dir). Restore owner-write first.
  while (tmps.length) {
    const dir = tmps.pop()!;
    spawnSync("chmod", ["-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectGarbage destructive (ADR 0007 — real --gc on a dedicated scratch store)", () => {
  e2e("frees unrooted paths while a scoped-rooted path survives a real collect", () => {
    const scratch = mkdtempSync(join(tmpdir(), "dustcastle-gc-scratch-"));
    tmps.push(scratch);

    // SAFETY: point nix-portable at the scratch NP_LOCATION so the destructive
    // --gc operates only on this throwaway store. Restored in `finally` so it never
    // leaks to another test. Guard before any sweep: refuse unless this is a scratch
    // dir under the OS tmpdir and NOT the developer's warm store ($HOME).
    const prevNpLocation = process.env.NP_LOCATION;
    process.env.NP_LOCATION = scratch;
    try {
      const npLocation = process.env.NP_LOCATION;
      if (npLocation === homedir() || !npLocation.startsWith(tmpdir())) {
        throw new Error(`refusing destructive gc: NP_LOCATION '${npLocation}' is not a scratch dir`);
      }

      const run = nixPortableRunner();

      // The fresh store's collectable (dead) paths after bootstrap. Pick one regular
      // path (not a .drv) to root — realising an existing valid path just pins it,
      // no build/fetch — leaving the rest collectable so the sweep frees something.
      const deadBefore = run(gcQueryArgs("dead")).stdout;
      const survivor = deadBefore
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("/nix/store/") && !l.endsWith(".drv"));
      expect(survivor, "a fresh scratch store should have a collectable regular path to root").toBeTruthy();

      // Use dustcastle's real scoped-root machinery to pin the survivor.
      const handle = registerScopedRoots({
        provisioned: { toolchainStorePath: survivor!, depsStorePath: "" },
        gcrootsDir: join(scratch, "gcroots"),
        projectKey: "gc-collect-e2e",
        run,
      });
      expect(handle.links).toHaveLength(1);

      try {
        // The real, destructive sweep: deletes the store's remaining unrooted paths
        // while the scoped-rooted survivor is kept.
        const report = collectGarbage({ run });
        expect(report.gc.pathsDeleted).toBeGreaterThan(0); // really freed unrooted paths

        // The scoped-rooted path SURVIVED a real collect: still live, not dead.
        const live = run(gcQueryArgs("live"));
        const dead = run(gcQueryArgs("dead"));
        expect(live.stdout).toContain(survivor!);
        expect(dead.stdout).not.toContain(survivor!);
      } finally {
        handle.release();
      }
    } finally {
      if (prevNpLocation === undefined) delete process.env.NP_LOCATION;
      else process.env.NP_LOCATION = prevNpLocation;
    }
  });
});

describe("autoGc destructive (ADR 0007 — real optimise-first → conditional gc, warm set survives)", () => {
  e2e("optimises then collects, keeping BOTH the scoped and recency-rooted closures", () => {
    const scratch = mkdtempSync(join(tmpdir(), "dustcastle-autogc-scratch-"));
    tmps.push(scratch);

    const prevNpLocation = process.env.NP_LOCATION;
    process.env.NP_LOCATION = scratch;
    try {
      const npLocation = process.env.NP_LOCATION;
      if (npLocation === homedir() || !npLocation.startsWith(tmpdir())) {
        throw new Error(`refusing destructive gc: NP_LOCATION '${npLocation}' is not a scratch dir`);
      }

      const run = nixPortableRunner();

      // Two collectable regular paths in the fresh scratch store: one we pin with a
      // SCOPED (in-flight) root, one with a PERSISTENT recency root. Both must
      // survive a real optimise→gc; the store's remaining unrooted paths must not.
      const dead = run(gcQueryArgs("dead"))
        .stdout.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/nix/store/") && !l.endsWith(".drv"));
      const scopedPath = dead[0];
      const recencyPath = dead[1];
      expect(scopedPath, "scratch store should have ≥2 collectable regular paths").toBeTruthy();
      expect(recencyPath, "scratch store should have ≥2 collectable regular paths").toBeTruthy();

      // Pin the scoped survivor (released at the end, like a live run).
      const scoped = registerScopedRoots({
        provisioned: { toolchainStorePath: scopedPath!, depsStorePath: "" },
        gcrootsDir: join(scratch, "gcroots"),
        projectKey: "autogc-scoped",
        run,
      });
      // Pin the recency survivor + record it warm, so the byte-budget tail keeps it.
      const recencyRootsDir = join(scratch, "recency-roots");
      registerRecencyRoot({
        provisioned: { toolchainStorePath: recencyPath!, depsStorePath: "" },
        recencyRootsDir,
        projectKey: "autogc-recency",
        run,
      });
      upsertRecency(scratch, { projectKey: "autogc-recency", lastUsedAt: 1, closureBytes: 10 });

      try {
        // Force the trigger via injected size/disk (the ceiling derivation is unit-
        // tested separately): on a total of 600 → cap 60, budget 42. store 80 ≥ cap
        // → sweep; optimise leaves the logical size unchanged → falls through to a
        // real gc; the warm record (10 bytes ≤ 42) stays in budget so its root survives.
        const report = autoGc({
          run,
          measure: () => 80,
          disk: () => ({ free: 300, total: 600 }),
          dir: scratch,
          recencyRootsDir,
          now: () => 1,
        });

        expect(report).not.toBe("skipped");
        if (report === "skipped") return;
        expect(report.swept).toBe(true);
        expect(report.reason).toBe("cap");
        expect(report.optimise).toBeDefined(); // optimise ran first
        expect(report.gc?.pathsDeleted).toBeGreaterThan(0); // gc really freed unrooted paths

        // BOTH protected closures survived the real collect; still live, not dead.
        const live = run(gcQueryArgs("live")).stdout;
        const deadAfter = run(gcQueryArgs("dead")).stdout;
        expect(live).toContain(scopedPath!);
        expect(live).toContain(recencyPath!);
        expect(deadAfter).not.toContain(scopedPath!);
        expect(deadAfter).not.toContain(recencyPath!);
      } finally {
        scoped.release();
      }
    } finally {
      if (prevNpLocation === undefined) delete process.env.NP_LOCATION;
      else process.env.NP_LOCATION = prevNpLocation;
    }
  });
});
