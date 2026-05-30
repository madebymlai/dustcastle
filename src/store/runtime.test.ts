import { describe, expect, it } from "vitest";
import { chooseRuntimeMode } from "./runtime.js";

// ADR 0008: nix-portable presents the store via a bwrap user namespace, which
// needs unprivileged user namespaces; where they're disabled it falls back to
// proot (slower, but works anywhere). dustcastle picks deterministically and
// surfaces the active mode — never silently degrades.

describe("chooseRuntimeMode (ADR 0008 bwrap→proot)", () => {
  it("uses the fast bwrap path when unprivileged user namespaces are available", () => {
    expect(chooseRuntimeMode({ unprivilegedUserns: true })).toBe("bwrap");
  });

  it("falls back to proot when user namespaces are unavailable", () => {
    expect(chooseRuntimeMode({ unprivilegedUserns: false })).toBe("proot");
  });
});
