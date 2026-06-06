import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Detection } from "../../detect/index.js";
import { completeMarker, depsCacheDecision, installSuccessSentinel, populateCommand, restoreCommand } from "./index.js";

// The host-side deps-cache hit/miss decision + copy builders (ADR 0016). Every
// detected ecosystem gets a deps fingerprint. HIT requires a complete cached stage;
// MISS installs in-Sandbox, then populate copies only after the install success sentinel.
// The cache root is run-level config, so decisions do not carry cacheDir.

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dustcastle-depscache-dec-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const npm: Detection = { ecosystem: "node", packageManager: "npm" };

describe("depsCacheDecision (host-side hit/miss — ADR 0016)", () => {
  it("HIT: a populated entry for a fingerprint restores", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package-lock.json"), "{}");
    const miss = depsCacheDecision(project, npm, cacheDir);
    mkdirSync(join(cacheDir, miss.depsKey, "node_modules"), { recursive: true });
    writeFileSync(completeMarker(cacheDir, miss.depsKey), "");

    const decision = depsCacheDecision(project, npm, cacheDir);
    expect(decision).toEqual({ hit: true, depsKey: miss.depsKey });
  });

  it("MISS: a fingerprint with no complete entry yet is a miss", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package-lock.json"), "{}");

    const decision = depsCacheDecision(project, npm, cacheDir);
    expect(decision.hit).toBe(false);
    expect(decision.depsKey).toBeDefined();
  });

  it("MISS: a loose / no-lockfile ecosystem is still cacheable by deps fingerprint", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package.json"), "{}");

    const decision = depsCacheDecision(project, { ...npm, loose: true }, cacheDir);
    expect(decision.hit).toBe(false);
    expect(decision.depsKey).toBeDefined();
  });

  it("treats an entry dir without complete cached content as a miss (poison self-heal)", () => {
    const project = tmp();
    const cacheDir = tmp();
    writeFileSync(join(project, "package-lock.json"), "{}");
    const decision = depsCacheDecision(project, npm, cacheDir);
    mkdirSync(join(cacheDir, decision.depsKey), { recursive: true });

    expect(depsCacheDecision(project, npm, cacheDir).hit).toBe(false);
  });
});

describe("deps-cache shell command builders (copy assembled deps — ADR 0016)", () => {
  it("restores a hit from the cache content path and touches the entry dir for recency", () => {
    const cmd = restoreCommand({
      cacheDir: "/c",
      depsKey: "abc",
      stageDir: "node_modules",
    });

    expect(cmd).toBe(
      "if [ -f '/c/abc/.dustcastle-deps-cache-complete' ] && [ -d '/c/abc/node_modules' ]; then " +
        "rm -f '.dustcastle-deps-install-success-node_modules' && rm -rf 'node_modules' && cp -a '/c/abc/node_modules' 'node_modules' && chmod -R u+rwX 'node_modules' && touch '/c/abc'; " +
        "fi",
    );
  });

  it("populates only when the install success sentinel is present, excluding the sentinel from the cached stage", () => {
    const cmd = populateCommand({
      cacheDir: "/c",
      depsKey: "abc",
      stageDir: "node_modules",
    });

    expect(cmd).toBe(
      "if [ -f '.dustcastle-deps-install-success-node_modules' ] && [ -d 'node_modules' ]; then " +
        "mkdir -p '/c/abc' && rm -f '/c/abc/.dustcastle-deps-cache-complete' && rm -rf '/c/abc/node_modules.tmp' && cp -a 'node_modules' '/c/abc/node_modules.tmp' && rm -rf '/c/abc/node_modules' && mv '/c/abc/node_modules.tmp' '/c/abc/node_modules' && touch '/c/abc/.dustcastle-deps-cache-complete'; " +
        "fi",
    );
    expect(cmd).not.toContain(`cp -a '${installSuccessSentinel("node_modules")}'`);
  });

  it("populates through dangling symlinks and restores relative node bin shims to a new worktree", () => {
    const cacheDir = tmp();
    const original = tmp();
    const restored = tmp();
    const depsKey = "abc";

    mkdirSync(join(original, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(original, "node_modules", "real-pkg"), { recursive: true });
    const cli = join(original, "node_modules", "real-pkg", "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\nconsole.log('shim-ok');\n");
    chmodSync(cli, 0o755);
    symlinkSync("../real-pkg/cli.js", join(original, "node_modules", ".bin", "real-pkg"));
    symlinkSync("../missing-target", join(original, "node_modules", "dangling-link"));
    writeFileSync(join(original, installSuccessSentinel("node_modules")), "");

    execSync(populateCommand({ cacheDir, depsKey, stageDir: "node_modules" }), { cwd: original, shell: "/bin/sh" });

    expect(existsSync(completeMarker(cacheDir, depsKey))).toBe(true);

    execSync(restoreCommand({ cacheDir, depsKey, stageDir: "node_modules" }), { cwd: restored, shell: "/bin/sh" });

    expect(execFileSync(join(restored, "node_modules", ".bin", "real-pkg"), { encoding: "utf8" })).toBe("shim-ok\n");
  });
});
