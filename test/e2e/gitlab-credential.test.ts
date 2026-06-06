import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeCredentialValue } from "../../src/config/global.js";
import { prepareRun } from "../../src/run/index.js";
import { runInSandbox, stageNodeProject } from "./fixture.js";

// End-to-end GitLab credential gate (ADR 0018 / dustcastle-dfo.4). Requires:
//   DUSTCASTLE_E2E=1
//   DUSTCASTLE_GITLAB_TOKEN=<token with access to the repo>
//   DUSTCASTLE_GITLAB_PRIVATE_REPO_URL=https://gitlab.com/org/private-repo.git
const e2e = process.env.DUSTCASTLE_E2E ? it : it.skip;

const tmps: string[] = [];
afterAll(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe("GitLab credential injection e2e", () => {
  e2e("authenticates a private GitLab HTTPS clone in-sandbox without a tokenized URL", async () => {
    const token = process.env.DUSTCASTLE_GITLAB_TOKEN;
    const repoUrl = process.env.DUSTCASTLE_GITLAB_PRIVATE_REPO_URL;
    if (token === undefined || repoUrl === undefined) {
      console.warn("skipping GitLab credential e2e: set DUSTCASTLE_GITLAB_TOKEN and DUSTCASTLE_GITLAB_PRIVATE_REPO_URL");
      return;
    }
    expect(repoUrl).toMatch(/^https:\/\/gitlab\.com\//);
    expect(repoUrl).not.toContain(token);

    const root = mkdtempSync(join(tmpdir(), "dustcastle-gl-credential-"));
    tmps.push(root);
    const projectDir = stageNodeProject(root);
    const configDir = join(root, "dustcastle-home");
    writeCredentialValue("GITLAB_TOKEN", token, { dir: configDir });

    const prepared = await prepareRun({ cwd: projectDir, configDir });
    const env = prepared.plan.podmanOptions.env ?? {};
    expect(env.GITLAB_TOKEN).toBe(token);
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://gitlab.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("oauth2");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(token);

    await runInSandbox({
      prepared,
      projectDir,
      container: "dustcastle-gitlab-credential-e2e",
      test: { command: "npm test", expect: /ok/ },
      afterSetup: async (exec) => {
        const clone = await exec(`git ls-remote '${repoUrl}' HEAD`);
        expect(clone.code, clone.err).toBe(0);
        expect(clone.out).toMatch(/[0-9a-f]{40}/);
        expect(clone.err).not.toContain(token);
      },
    });
  });
});
