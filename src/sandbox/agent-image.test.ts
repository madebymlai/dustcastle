import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_SPEC, ensureImage, type PodmanRunner } from "./image.js";

// The agent image is a dustcastle-owned artifact (like nix-portable): built once
// from the shipped Containerfile, then consumed by sandcastle's podman provider by
// name. ensureImage's build behaviour is covered in image.test.ts; here we only
// assert AGENT_SPEC wires that core to the right tag, Containerfile, and log prefix.

describe("the dustcastle-owned agent image (AGENT_SPEC)", () => {
  it("names the local agent tag, prefix, and noun, and ships its Containerfile beside the module", () => {
    expect(AGENT_SPEC.tag).toBe("localhost/dustcastle-agent:bookworm");
    expect(AGENT_SPEC.containerfile).toMatch(/agent\.Containerfile$/);
    expect(AGENT_SPEC.label).toBe("agent image");
  });

  it("ships its Containerfile as a real resolvable file (so dist copy-assets stays wired)", () => {
    expect(existsSync(AGENT_SPEC.containerfile)).toBe(true);
  });

  it("builds the agent image through ensureImage from that spec", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const image = ensureImage(AGENT_SPEC, { exists: () => false, run });
    expect(image).toBe(AGENT_SPEC.tag);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", AGENT_SPEC.tag]);
    expect(args?.some((a) => a.endsWith("agent.Containerfile"))).toBe(true);
  });

  it("renders the agent prefix and noun in the build-failure error (real strings, not synthetic)", () => {
    const run: PodmanRunner = () => ({ status: 1, stderr: "boom: no base image" });
    expect(() => ensureImage(AGENT_SPEC, { exists: () => false, run })).toThrowError(
      /failed to build the agent image .*boom/s,
    );
  });
});
