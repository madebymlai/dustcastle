import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  diskSpace,
  measureStoreBytes,
  minFreeBytes,
  overCeiling,
  recencyBudgetBytes,
  storeCapBytes,
} from "./ceiling.js";
import type { NixResult } from "./nix.js";

// The hybrid high/low watermark (ADR 0007). A sweep fires when EITHER the Store
// exceeds a disk-derived size cap (high watermark) OR free space on the Store's
// filesystem drops below a floor — whichever bites first. Both thresholds derive
// from the actual filesystem (zero-config, machine-adaptive); the recency byte
// budget is the strictly-lower LOW watermark we land at, so GC cannot thrash at
// the boundary. The derivation is pure (takes totalBytes); the statfs / nix size
// accounting it consumes is injected, so this is unit-tested without a real disk.

const OK = (stdout = "", stderr = ""): NixResult => ({ status: 0, stdout, stderr });

describe("overCeiling (the hybrid cap-OR-floor trigger — ADR 0007)", () => {
  // total = 1000 → cap = 100 (0.1), minFree = 100 (0.1).
  it("fires on the size cap when the store outgrows its disk-derived ceiling", () => {
    expect(overCeiling({ storeBytes: 200, freeBytes: 500, totalBytes: 1000 })).toEqual({
      over: true,
      reason: "cap",
    });
  });

  it("fires on the free-space floor even when the store itself is small", () => {
    expect(overCeiling({ storeBytes: 50, freeBytes: 50, totalBytes: 1000 })).toEqual({
      over: true,
      reason: "floor",
    });
  });

  it("reports the cap reason when both the cap and the floor bite", () => {
    expect(overCeiling({ storeBytes: 200, freeBytes: 50, totalBytes: 1000 })).toEqual({
      over: true,
      reason: "cap",
    });
  });

  it("does not fire when the store is under the cap and the disk is roomy", () => {
    expect(overCeiling({ storeBytes: 50, freeBytes: 500, totalBytes: 1000 })).toEqual({
      over: false,
      reason: "none",
    });
  });
});

describe("watermark derivation (machine-adaptive, hysteresis — ADR 0007)", () => {
  it("derives every threshold from the disk total — no baked-in absolute number", () => {
    // A 4 TB workstation is allowed a proportionally larger store than a 256 GB laptop.
    const tb4 = 4_000_000_000_000;
    const gb256 = 256_000_000_000;
    expect(storeCapBytes({ totalBytes: tb4 })).toBeGreaterThan(storeCapBytes({ totalBytes: gb256 }));
    expect(storeCapBytes({ totalBytes: tb4 }) / tb4).toBeCloseTo(
      storeCapBytes({ totalBytes: gb256 }) / gb256,
    );
  });

  it("lands the warm budget strictly below the trigger cap (hysteresis gap)", () => {
    // The low watermark (recency byte budget) is below the high watermark (cap), so
    // a sweep that collects down to the budget leaves headroom and cannot re-trigger.
    const total = 100_000_000_000;
    expect(recencyBudgetBytes({ totalBytes: total })).toBeLessThan(storeCapBytes({ totalBytes: total }));
    expect(minFreeBytes({ totalBytes: total })).toBeGreaterThan(0);
  });
});

describe("measureStoreBytes (nix size accounting, not a du walk — ADR 0007)", () => {
  it("sums the per-path nar sizes from `nix path-info --all --json` (array form)", () => {
    const json = JSON.stringify([
      { path: "/nix/store/a", narSize: 1000 },
      { path: "/nix/store/b", narSize: 2500 },
    ]);
    const run = (args: readonly string[]): NixResult => {
      expect(args).toContain("path-info");
      expect(args).toContain("--all");
      return OK(json);
    };
    expect(measureStoreBytes(run)).toBe(3500);
  });

  it("also handles the object-map form of `--json`", () => {
    const json = JSON.stringify({
      "/nix/store/a": { narSize: 1000 },
      "/nix/store/b": { narSize: 2500 },
    });
    expect(measureStoreBytes(() => OK(json))).toBe(3500);
  });

  it("degrades to 0 when the size query fails (best-effort — never breaks a run)", () => {
    expect(measureStoreBytes(() => ({ status: 1, stdout: "", stderr: "boom" }))).toBe(0);
    expect(measureStoreBytes(() => OK("not json"))).toBe(0);
  });
});

describe("diskSpace (statfs free/total — ADR 0007)", () => {
  it("reports free ≤ total > 0 for a real path", () => {
    const { free, total } = diskSpace(tmpdir());
    const fs = statfsSync(tmpdir());
    expect(total).toBe(fs.bsize * fs.blocks);
    expect(free).toBeLessThanOrEqual(total);
    expect(total).toBeGreaterThan(0);
  });
});
