import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confine, confineRouteScript } from "./confine.js";

// Egress confinement facade (ADR 0005/0010/0012): pure derivation yields both the
// surfaced decision and the podman network/env posture the Sandbox plan applies.

describe("confine posture", () => {
  it("routes an allowlisted sandbox through the resolved proxy address", () => {
    const confinement = confine({
      projectDir: process.cwd(),
      packageManagers: ["npm"],
      proxyAddress: "http://10.0.0.2:8118",
    });

    expect(confinement.posture.network).toBe("dustcastle-egress");
    expect(confinement.posture.env).toMatchObject({
      HTTP_PROXY: "http://10.0.0.2:8118",
      HTTPS_PROXY: "http://10.0.0.2:8118",
      http_proxy: "http://10.0.0.2:8118",
      https_proxy: "http://10.0.0.2:8118",
      npm_config_proxy: "http://10.0.0.2:8118",
      npm_config_https_proxy: "http://10.0.0.2:8118",
    });
  });

  it("closes the sandbox network and emits no proxy env when there is no egress", () => {
    const confinement = confine({ projectDir: mkdtempSync(join(tmpdir(), "dustcastle-confine-closed-")), packageManagers: [] });
    expect(confinement.decision).toEqual({ kind: "none" });
    expect(confinement.posture).toEqual({ network: "none", env: {} });
  });
});

describe("confineRouteScript (the privilege-stripped-host fallback — pasta route-strip)", () => {
  it("adds a host route to the proxy then drops the default route (proxy = only egress)", () => {
    const script = confineRouteScript("169.254.7.7");
    expect(script).toContain("169.254.7.7/32");
    expect(script).toMatch(/route\s+del\s+default/);
    expect(script).toContain("default");
  });
});
