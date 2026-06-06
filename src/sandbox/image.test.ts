import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { runStreamingAsync } from "../process/streaming.js";
import { ensureImage, imageRef, buildArgs, type ImageSpec, type PodmanRunner } from "./image.js";

// ensureImage is the deep core both dustcastle-owned images run through: a
// built-once, idempotent `podman build` driven by an ImageSpec (tag, Containerfile,
// labels). These cover the build-vs-skip decision, the build invocation, and the
// failure surface once, through a synthetic spec; the per-image wiring (agent) is
// asserted in agent-image.test.ts, and the real image build is proven by the gated e2e.

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

  it("skips the build when the version-derived image already exists (idempotent)", async () => {
    let ran = false;
    const run: PodmanRunner = async () => {
      ran = true;
      return { status: 0, stderr: "" };
    };
    const image = await ensureImage(SPEC, { version: V, exists: (img) => img === REF, run });
    expect(image).toBe(REF);
    expect(ran).toBe(false);
  });

  it("builds the version-derived tag from the spec's Containerfile when the image is missing", async () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = async (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    const image = await ensureImage(SPEC, { version: V, exists: () => false, run, logger });
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
  // content-busting, `exists` misses the NEW ref and the rebuild actually happens.
  it("rebuilds when the version changes even though the prior version's image still exists", async () => {
    const oldRef = imageRef(SPEC, "0.3.0");
    const newRef = imageRef(SPEC, "0.4.0");
    expect(newRef).not.toBe(oldRef); // the bump alone busts the tag
    let built: string | undefined;
    const run: PodmanRunner = async (a) => {
      built = a[2]; // the `-t <tag>` value
      return { status: 0, stderr: "" };
    };
    // Only the OLD image is cached; ask for the new one.
    const image = await ensureImage(SPEC, { version: "0.4.0", exists: (img) => img === oldRef, run });
    expect(image).toBe(newRef);
    expect(built).toBe(newRef); // it really invoked a build of the new tag, not a no-op
  });

  it("imageRef appends the version to the stable tag prefix so upgrades bust the cache", () => {
    expect(imageRef(SPEC, "1.2.3")).toBe(`${SPEC.tag}-1.2.3`);
    expect(imageRef(SPEC, "0.3.0")).not.toBe(imageRef(SPEC, "0.4.0"));
  });

  it("logs and throws an actionable error tagged with the bound module and label when the build fails", async () => {
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    const run: PodmanRunner = async () => ({ status: 1, stderr: "boom: no base image" });
    await expect(ensureImage(SPEC, { exists: () => false, run, logger })).rejects.toThrowError(
      /failed to build the test image .*boom/s,
    );
    expect(root.records.some((r) => r.level === "error" && r.msg === "failed to build dustcastle image")).toBe(true);
  });

  it("builds with the Containerfile's own directory as the context", () => {
    const cf = "/x/sandbox/test.Containerfile";
    expect(buildArgs("img:tag", cf)).toEqual(["build", "-t", "img:tag", "-f", cf, "/x/sandbox"]);
  });

  it("streams podman build stderr lines live — a line lands BEFORE the child 'close' event", async () => {
    const root = createMemoryLogger();
    const logger = root.child({ mod: "test" });
    let runFinished = false;

    const run: PodmanRunner = (args) => {
      const promise = runStreamingAsync(
        "node",
        [
          "-e",
          "process.stderr.write('STEP 1/5: FROM node:20-alpine\\n'); setTimeout(() => process.exit(0), 200);",
        ],
        {
          logger,
          label: "podman",
        },
      );
      promise.then(() => {
        runFinished = true;
      });
      return promise;
    };

    const imagePromise = ensureImage(SPEC, { version: V, exists: () => false, run, logger });

    // Poll until the line hits the logger — must happen BEFORE the child closes.
    await waitUntil(
      () => root.records.some((r) => r.fields.line === "STEP 1/5: FROM node:20-alpine"),
    );
    expect(runFinished).toBe(false); // run hasn't settled yet — line arrived live

    const image = await imagePromise;
    expect(image).toBe(REF);
    expect(runFinished).toBe(true);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
