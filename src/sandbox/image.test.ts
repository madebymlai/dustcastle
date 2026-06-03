import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
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
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    const image = ensureImage(SPEC, { exists: () => false, run, logger });
    expect(image).toBe(SPEC.tag);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", SPEC.tag]);
    expect(args).toContain("-f");
    expect(args).toContain(SPEC.containerfile);
    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "test", image: SPEC.tag, label: "test image" },
        msg: "building dustcastle image",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "test", image: SPEC.tag, label: "test image" },
        msg: "built dustcastle image",
        args: [],
      },
    ]);
  });

  it("logs and throws an actionable error tagged with the bound module and label when the build fails", () => {
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    const run: PodmanRunner = () => ({ status: 1, stderr: "boom: no base image" });
    expect(() => ensureImage(SPEC, { exists: () => false, run, logger })).toThrowError(
      /failed to build the test image .*boom/s,
    );
    expect(root.records.some((r) => r.level === "error" && r.msg === "failed to build dustcastle image")).toBe(true);
  });

  it("builds with the Containerfile's own directory as the context", () => {
    const cf = "/x/sandbox/test.Containerfile";
    expect(buildArgs("img:tag", cf)).toEqual(["build", "-t", "img:tag", "-f", cf, "/x/sandbox"]);
  });
});
