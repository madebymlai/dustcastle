import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CARGO_HOME_BASENAME } from "../../src/ecosystems/rust.js";
import { EGRESS_NETWORK } from "../../src/sandbox/confine.js";
import { egressHosts } from "../../src/sandbox/egress.js";
import { prepareRun } from "../../src/run/index.js";
import { runInSandbox, stageRustCrateProject, stageRustGitProject, stageRustProject } from "./fixture.js";

// Rust path under ADR 0012 (dustcastle-gy5.2/kzw): a Cargo crate → dustcastle
// provisions the Rust Toolchain (only) → `cargo fetch` populates the per-project
// CARGO_HOME IN-SANDBOX, routed through the standing egress proxy (the crates index
// is on the allowlist), then `cargo test --offline` runs green against the fetched
// cache — NOT a Store-vendored offline build.
//
// (Pre-ADR-0012 deps were Nix-vendored into CARGO_HOME and `network: none`; that
// model is gone — see ADR 0012 and dustcastle-61j.) Gated by DUSTCASTLE_E2E=1.
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

async function expectRustFixture(
  stage: (root: string) => string,
  tmpPrefix: string,
  container: string,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), tmpPrefix));
  tmps.push(root);
  const projectDir = stage(root);

  const prepared = await prepareRun({ cwd: projectDir });
  expect(prepared.detection).toMatchObject({ ecosystem: "rust", packageManager: "cargo" });
  expect(prepared.plan.egress.kind).toBe("allowlist");
  expect(prepared.plan.podmanOptions.network).toBe(EGRESS_NETWORK);
  expect(egressHosts(prepared.plan.egress)).toContain("index.crates.io");
  expect(egressHosts(prepared.plan.egress)).toContain("static.crates.io"); // crate downloads

  // `cargo fetch` installs in-Sandbox into the per-project CARGO_HOME (the stage dir).
  expect(prepared.plan.setupCommands.join("\n")).toContain("cargo fetch");
  expect(prepared.plan.setupCommands.join("\n")).toContain(CARGO_HOME_BASENAME);

  await runInSandbox({
    prepared,
    projectDir,
    container,
    // `cargo fetch` populated CARGO_HOME; the per-project CARGO_HOME dir now exists.
    afterSetup: async (exec) => {
      const cargoHome = await exec('test -d "$CARGO_HOME" && printf CARGO_HOME_OK');
      expect(cargoHome.out).toContain("CARGO_HOME_OK");
    },
    test: { command: "cargo test --offline", expect: /test result: ok/ },
  });
}

describe("dustcastle run — Rust in-Sandbox install (dustcastle-gy5.2/kzw, ADR 0012)", () => {
  e2e("fetches deps in-Sandbox and runs cargo test green (zero-dependency crate)", async () => {
    await expectRustFixture(stageRustProject, "dustcastle-rust-run-", "dustcastle-rust-run-e2e");
  });

  e2e("fetches a Cargo git dependency in-Sandbox via the proxy and runs cargo test green", async () => {
    await expectRustFixture(stageRustGitProject, "dustcastle-rust-git-run-", "dustcastle-rust-git-run-e2e");
  });

  e2e("fetches a real crates.io dependency in-Sandbox via the proxy and runs cargo test green", async () => {
    await expectRustFixture(stageRustCrateProject, "dustcastle-rust-crate-run-", "dustcastle-rust-crate-run-e2e");
  });
});
