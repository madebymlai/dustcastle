import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { detect } from "../../src/detect/index.js";
import { physPath, provisionStore } from "../../src/store/index.js";
import { KNOWN_VENDOR_HASH, stageSampleProject } from "./fixture.js";

// Integration: realize a real Go project into the rootless Store via nix-portable
// (ADR 0004/0008). Gated behind DUSTCASTLE_E2E=1 — the bare unit suite stays fast.
// Reuses the proven spike fixture + its known vendorHash for a warm-store cache
// hit; the `app` build runs `go test` offline in the Nix sandbox (first green gate).
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("provisionStore (rootless Store, ADR 0004/0008)", () => {
  e2e("realizes the Go toolchain + deps; offline `go test` passes during the build", () => {
    const root = mkdtempSync(join(tmpdir(), "dustcastle-e2e-"));
    tmps.push(root);
    const projectDir = stageSampleProject(root);

    const detection = detect(projectDir)[0];
    expect(detection?.packageManager).toBe("go");

    const provisioned = provisionStore({
      projectDir,
      detection: detection!,
      vendorHash: KNOWN_VENDOR_HASH,
    });

    // The Toolchain and Project Deps land as distinct content-addressed paths.
    expect(provisioned.toolchainStorePath).toMatch(/^\/nix\/store\/.+-go-\d/);
    expect(provisioned.depsStorePath).toMatch(/go-modules$/);
    expect(provisioned.vendorHash).toBe(KNOWN_VENDOR_HASH);

    // The active rootless runtime is surfaced (ADR 0008), and the canonical
    // store paths resolve to real files under the physical store root.
    expect(provisioned.mode).toBe("bwrap");
    expect(existsSync(physPath(provisioned.physStoreRoot, provisioned.toolchainStorePath))).toBe(
      true,
    );
    expect(existsSync(physPath(provisioned.physStoreRoot, provisioned.depsStorePath))).toBe(true);
  });
});
