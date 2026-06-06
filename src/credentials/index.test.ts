import { describe, expect, it } from "vitest";
import { buildPiAgent } from "../config/global.js";
import {
  CREDENTIALS,
  credentialDescriptor,
  credentialEnv,
  validateCredentialKeysDisjointFromAgentEnv,
} from "./index.js";

describe("Credential Registry", () => {
  it("ships GitHub and GitLab as closed descriptors with env names and git username conventions", () => {
    expect(CREDENTIALS.map((c) => c.credential)).toEqual(["github", "gitlab"]);
    expect(credentialDescriptor("github")).toMatchObject({
      label: "GitHub",
      envName: "GITHUB_TOKEN",
      git: { host: "github.com", username: "x-access-token" },
    });
    expect(credentialDescriptor("gitlab")).toMatchObject({
      label: "GitLab",
      envName: "GITLAB_TOKEN",
      git: { host: "gitlab.com", username: "oauth2" },
    });
  });

  it("injects configured forge tokens plus ambient host-scoped git credential helpers without putting tokens in helpers", () => {
    const env = credentialEnv({ GITHUB_TOKEN: "ghp_secret", GITLAB_TOKEN: "glpat_secret" });

    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.GITLAB_TOKEN).toBe("glpat_secret");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("x-access-token");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$GITHUB_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghp_secret");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://gitlab.com.helper");
    expect(env.GIT_CONFIG_VALUE_1).toContain("oauth2");
    expect(env.GIT_CONFIG_VALUE_1).toContain("$GITLAB_TOKEN");
    expect(env.GIT_CONFIG_VALUE_1).not.toContain("glpat_secret");
  });

  it("keeps the shipped credential env keys disjoint from pi's provider env", () => {
    expect(() => validateCredentialKeysDisjointFromAgentEnv(buildPiAgent({ model: "p/m" }).env)).not.toThrow();
  });

  it("fails before provisioning when an agent provider env would collide with a credential key", () => {
    expect(() => validateCredentialKeysDisjointFromAgentEnv({ GITHUB_TOKEN: "agent-owned" })).toThrow(
      /credential env GITHUB_TOKEN collides with agent provider env/,
    );
    expect(() => validateCredentialKeysDisjointFromAgentEnv({ GITLAB_TOKEN: "agent-owned" })).toThrow(
      /credential env GITLAB_TOKEN collides with agent provider env/,
    );
  });
});
