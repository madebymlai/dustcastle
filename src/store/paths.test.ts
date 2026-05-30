import { describe, expect, it } from "vitest";
import { physPath } from "./paths.js";

// ADR 0008: rootless adds exactly one thing dustcastle absorbs — a host-side
// path-prefix translation when staging. Inside the container the path is the
// canonical /nix/store/...; on the host it lives under the rootless store root.
// This seam is internal; it never reaches the user or the agent.

describe("physPath (ADR 0008 host-side path translation)", () => {
  const physRoot = "/home/agent/.dustcastle/nix-portable/nix/store";

  it("maps a canonical /nix/store path to its physical location on the host", () => {
    expect(physPath(physRoot, "/nix/store/abc123-go-1.26.3")).toBe(
      "/home/agent/.dustcastle/nix-portable/nix/store/abc123-go-1.26.3",
    );
  });

  it("tolerates a trailing slash on the store root", () => {
    expect(physPath(`${physRoot}/`, "/nix/store/xyz-sample")).toBe(
      "/home/agent/.dustcastle/nix-portable/nix/store/xyz-sample",
    );
  });
});
