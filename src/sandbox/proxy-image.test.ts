import { describe, expect, it } from "vitest";
import { PROXY_SPEC, ensureImage, type PodmanRunner } from "./image.js";

// The egress-proxy image is a dustcastle-owned artifact (like the agent image):
// built once from the shipped Containerfile, then run by ensureEgress by name. The
// stock node:20-alpine has no proxy code, so without this the proxy container died
// on start and the allowlist was enforced over a dead proxy. ensureImage's build
// behaviour is covered in image.test.ts; here we only assert PROXY_SPEC wires that
// core to the right tag, Containerfile, and log prefix.

describe("the dustcastle-owned egress-proxy image (PROXY_SPEC)", () => {
  it("names the local proxy tag and ships its Containerfile beside the module", () => {
    expect(PROXY_SPEC.tag).toBe("localhost/dustcastle-egress-proxy:node20");
    expect(PROXY_SPEC.containerfile).toMatch(/proxy\.Containerfile$/);
    expect(PROXY_SPEC.logPrefix).toBe("egress");
  });

  it("builds the proxy image through ensureImage from that spec", () => {
    let args: readonly string[] | undefined;
    const run: PodmanRunner = (a) => {
      args = a;
      return { status: 0, stderr: "" };
    };
    const image = ensureImage(PROXY_SPEC, { exists: () => false, run });
    expect(image).toBe(PROXY_SPEC.tag);
    expect(args?.slice(0, 3)).toEqual(["build", "-t", PROXY_SPEC.tag]);
    expect(args?.some((a) => a.endsWith("proxy.Containerfile"))).toBe(true);
  });
});
