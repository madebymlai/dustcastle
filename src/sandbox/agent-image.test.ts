import { describe, expect, it } from "vitest";
import {
  AGENT_IMAGE,
  agentBuildArgs,
  agentContainerfilePath,
  ensureAgentImage,
  type PodmanRunner,
} from "./agent-image.js";

// The agent image is a dustcastle-owned artifact (like nix-portable): built once
// from the shipped Containerfile, then consumed by sandcastle's podman provider by
// name. These cover the build-vs-skip decision and the build invocation; the real
// image build + the implement→review→merge loop are proven by the gated e2e.

describe("ensureAgentImage (the dustcastle-owned agent image)", () => {
  it("skips the build when the image already exists (idempotent)", () => {
    let ran = false;
    const run: PodmanRunner = () => {
      ran = true;
      return { status: 0, stderr: "" };
    };
    const image = ensureAgentImage({ exists: () => true, run });
    expect(image).toBe(AGENT_IMAGE);
    expect(ran).toBe(false);
  });

  it("builds from the shipped Containerfile when the image is missing", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const image = ensureAgentImage({ exists: () => false, run });
    expect(image).toBe(AGENT_IMAGE);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", AGENT_IMAGE]);
    expect(args).toContain("-f");
    expect(args?.some((a) => a.endsWith("agent.Containerfile"))).toBe(true);
  });

  it("throws an actionable error when the build fails", () => {
    const run: PodmanRunner = () => ({ status: 1, stderr: "boom: no base image" });
    expect(() => ensureAgentImage({ exists: () => false, run })).toThrowError(
      /failed to build the agent image .*boom/s,
    );
  });

  it("points at a Containerfile that ships beside the module", () => {
    expect(agentContainerfilePath()).toMatch(/agent\.Containerfile$/);
  });

  it("builds with the Containerfile's own directory as the context", () => {
    const cf = "/x/sandbox/agent.Containerfile";
    expect(agentBuildArgs("img:tag", cf)).toEqual(["build", "-t", "img:tag", "-f", cf, "/x/sandbox"]);
  });
});
