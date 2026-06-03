import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { ensureImage, imageRef, buildArgs, type ImageSpec, type PodmanRunner } from "./image.js";

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
  // The version folded into the derived tag. Injected so the assertions don't track
  // the repo's real package.json version.
  const V = "9.9.9";
  const REF = imageRef(SPEC, V); // "localhost/test-image:latest-9.9.9"

  it("skips the build when the version-derived image already exists (idempotent)", () => {
    let ran = false;
    const run: PodmanRunner = () => {
      ran = true;
      return { status: 0, stderr: "" };
    };
    const image = ensureImage(SPEC, { version: V, exists: (img) => img === REF, run });
    expect(image).toBe(REF);
    expect(ran).toBe(false);
  });

  it("builds the version-derived tag from the spec's Containerfile when the image is missing", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    const image = ensureImage(SPEC, { version: V, exists: () => false, run, logger });
    expect(image).toBe(REF);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", REF]);
    expect(args).toContain("-f");
    expect(args).toContain(SPEC.containerfile);
    expect(root.records).toEqual([
      {
        level: "info",
        fields: { mod: "test", image: REF, label: "test image" },
        msg: "building dustcastle image",
        args: [],
      },
      {
        level: "info",
        fields: { mod: "test", image: REF, label: "test image" },
        msg: "built dustcastle image",
        args: [],
      },
    ]);
  });

  // The dustcastle-q9u regression: a prior image for an OLDER version is present, but
  // a release changed what the image bakes (here: a version bump). Because the tag is
  // content-busting, `exists` misses the NEW ref and the rebuild actually happens —
  // the exact thing the static `:node20` tag failed to do for the stale egress proxy.
  it("rebuilds when the version changes even though the prior version's image still exists", () => {
    const oldRef = imageRef(SPEC, "0.3.0");
    const newRef = imageRef(SPEC, "0.4.0");
    expect(newRef).not.toBe(oldRef); // the bump alone busts the tag
    let built: string | undefined;
    const run: PodmanRunner = (a) => {
      built = a[2]; // the `-t <tag>` value
      return { status: 0, stderr: "" };
    };
    // Only the OLD image is cached (the stale-proxy situation); ask for the new one.
    const image = ensureImage(SPEC, { version: "0.4.0", exists: (img) => img === oldRef, run });
    expect(image).toBe(newRef);
    expect(built).toBe(newRef); // it really invoked a build of the new tag, not a no-op
  });

  it("imageRef appends the version to the stable tag prefix so upgrades bust the cache", () => {
    expect(imageRef(SPEC, "1.2.3")).toBe(`${SPEC.tag}-1.2.3`);
    expect(imageRef(SPEC, "0.3.0")).not.toBe(imageRef(SPEC, "0.4.0"));
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
