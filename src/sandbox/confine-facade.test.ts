import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confine, egressHosts } from "./confine.js";

describe("confine facade (egress decision + sandbox posture)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  it("derives the union allowlist internally and resolves the proxy posture once", () => {
    const dir = mkdtempSync(join(tmpdir(), "dustcastle-confine-"));
    tmps.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lib: "git+https://gitlab.com/acme/lib.git" } }));
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);

    const confinement = confine({
      projectDir: dir,
      packageManagers: ["npm"],
      agentModelHosts: ["api.deepseek.com"],
      proxyAddress: "http://169.254.7.7:18118",
    });

    expect(confinement.decision).toEqual({
      kind: "allowlist",
      buildHosts: ["registry.npmjs.org", "gitlab.com", "github.com"],
      agentHosts: ["api.deepseek.com"],
    });
    expect(egressHosts(confinement.decision)).toEqual([
      "registry.npmjs.org",
      "gitlab.com",
      "github.com",
      "api.deepseek.com",
    ]);
    expect(confinement.posture.network).toBe("dustcastle-egress");
    expect(confinement.posture.env.HTTPS_PROXY).toBe("http://169.254.7.7:18118");
  });
});
