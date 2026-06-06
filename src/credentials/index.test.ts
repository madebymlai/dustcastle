import { describe, expect, it } from "vitest";
import { buildPiAgent } from "../config/global.js";
import {
  CREDENTIALS,
  credentialDescriptor,
  credentialEnv,
  validateCredentialKeysDisjointFromAgentEnv,
} from "./index.js";

describe("Credential Registry", () => {
  it("ships GitHub as a closed descriptor with its env name and git username convention", () => {
    expect(CREDENTIALS.map((c) => c.credential)).toEqual(["github"]);
    expect(credentialDescriptor("github")).toMatchObject({
      label: "GitHub",
      envName: "GITHUB_TOKEN",
      git: { host: "github.com", username: "x-access-token" },
    });
  });

  it("injects GITHUB_TOKEN plus ambient host-scoped git credential helper without putting the token in the helper", () => {
    const env = credentialEnv({ GITHUB_TOKEN: "ghp_secret" });

    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("x-access-token");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$GITHUB_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghp_secret");
  });

  it("keeps the shipped credential env keys disjoint from pi's provider env", () => {
    expect(() => validateCredentialKeysDisjointFromAgentEnv(buildPiAgent({ model: "p/m" }).env)).not.toThrow();
  });

  it("fails before provisioning when an agent provider env would collide with a credential key", () => {
    expect(() => validateCredentialKeysDisjointFromAgentEnv({ GITHUB_TOKEN: "agent-owned" })).toThrow(
      /credential env GITHUB_TOKEN collides with agent provider env/,
    );
  });
});
