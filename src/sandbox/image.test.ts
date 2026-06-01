import { describe, expect, it } from "vitest";
import { ensureImage, buildArgs, type ImageSpec, type PodmanRunner } from "./image.js";

// ensureImage is the deep core both dustcastle-owned images run through: a
// built-once, idempotent `podman build` driven by an ImageSpec (tag, Containerfile,
// labels). These cover the build-vs-skip decision, the build invocation, and the
// failure surface once, through a synthetic spec; the per-image wiring (agent,
// proxy) is asserted in agent-image.test.ts / proxy-image.test.ts, and the real
// image build is proven by the gated e2e.

const SPEC: ImageSpec = {
  tag: "localhost/test-image:latest",
  containerfile: "/x/sandbox/test.Containerfile",
  logPrefix: "test",
  label: "test image",
};

describe("ensureImage (the dustcastle-owned image build core)", () => {
  it("skips the build when the image already exists (idempotent)", () => {
    let ran = false;
    const run: PodmanRunner = () => {
      ran = true;
      return { status: 0, stderr: "" };
    };
    const image = ensureImage(SPEC, { exists: () => true, run });
    expect(image).toBe(SPEC.tag);
    expect(ran).toBe(false);
  });

  it("builds from the spec's Containerfile when the image is missing", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const image = ensureImage(SPEC, { exists: () => false, run });
    expect(image).toBe(SPEC.tag);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", SPEC.tag]);
    expect(args).toContain("-f");
    expect(args).toContain(SPEC.containerfile);
  });

  it("throws an actionable error tagged with the spec's prefix and label when the build fails", () => {
    const run: PodmanRunner = () => ({ status: 1, stderr: "boom: no base image" });
    expect(() => ensureImage(SPEC, { exists: () => false, run })).toThrowError(
      /test: failed to build the test image .*boom/s,
    );
  });

  it("builds with the Containerfile's own directory as the context", () => {
    const cf = "/x/sandbox/test.Containerfile";
    expect(buildArgs("img:tag", cf)).toEqual(["build", "-t", "img:tag", "-f", cf, "/x/sandbox"]);
  });
});
