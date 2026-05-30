import { describe, expect, it } from "vitest";
import {
  PROXY_IMAGE,
  ensureProxyImage,
  proxyBuildArgs,
  proxyContainerfilePath,
  type PodmanRunner,
} from "./proxy-image.js";

// The egress-proxy image is a dustcastle-owned artifact (like the agent image):
// built once from the shipped Containerfile, then run by ensureEgress by name. The
// stock node:20-alpine has no proxy code, so without this the proxy container died
// on start and the allowlist was enforced over a dead proxy. These cover the
// build-vs-skip decision and the build invocation; the real image build + a live
// egress run are proven by the gated e2e.

describe("ensureProxyImage (the dustcastle-owned egress-proxy image)", () => {
  it("skips the build when the image already exists (idempotent)", () => {
    let ran = false;
    const run: PodmanRunner = () => {
      ran = true;
      return { status: 0, stderr: "" };
    };
    const image = ensureProxyImage({ exists: () => true, run });
    expect(image).toBe(PROXY_IMAGE);
    expect(ran).toBe(false);
  });

  it("builds from the shipped Containerfile when the image is missing", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const image = ensureProxyImage({ exists: () => false, run });
    expect(image).toBe(PROXY_IMAGE);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", PROXY_IMAGE]);
    expect(args).toContain("-f");
    expect(args?.some((a) => a.endsWith("proxy.Containerfile"))).toBe(true);
  });

  it("throws an actionable error when the build fails", () => {
    const run: PodmanRunner = () => ({ status: 1, stderr: "boom: no base image" });
    expect(() => ensureProxyImage({ exists: () => false, run })).toThrowError(
      /failed to build the proxy image .*boom/s,
    );
  });

  it("points at a Containerfile that ships beside the module", () => {
    expect(proxyContainerfilePath()).toMatch(/proxy\.Containerfile$/);
  });

  it("builds with the Containerfile's own directory as the context (where the compiled proxy lives)", () => {
    const cf = "/x/sandbox/proxy.Containerfile";
    expect(proxyBuildArgs("img:tag", cf)).toEqual(["build", "-t", "img:tag", "-f", cf, "/x/sandbox"]);
  });
});
