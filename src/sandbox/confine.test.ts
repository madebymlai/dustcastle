import { describe, expect, it } from "vitest";
import {
  EGRESS_NETWORK,
  EGRESS_PROXY_CONTAINER,
  EGRESS_PROXY_PORT,
  confineRouteScript,
  egressNetworkCreateArgs,
  productionProxyUrl,
  proxyContainerRunArgs,
  proxyEnv,
} from "./confine.js";

// Egress confinement (ADR 0005) — the layer that makes the filtering proxy the
// build's ONLY way out. Production uses a podman-native internal network + a
// dual-homed proxy container; the live e2e on a privilege-stripped host uses a
// pasta route-strip. Both route untrusted install traffic through the same proxy.
// Only the pure spec generators are unit-tested here; the imperative podman calls
// run live (on a capable host) / in the gated e2e.

describe("proxyEnv (point a build's tooling at the egress proxy)", () => {
  it("sets the standard + npm proxy variables, upper and lower case", () => {
    const env = proxyEnv("http://10.0.0.2:8118");
    expect(env.HTTP_PROXY).toBe("http://10.0.0.2:8118");
    expect(env.HTTPS_PROXY).toBe("http://10.0.0.2:8118");
    expect(env.http_proxy).toBe("http://10.0.0.2:8118");
    expect(env.https_proxy).toBe("http://10.0.0.2:8118");
    expect(env.npm_config_proxy).toBe("http://10.0.0.2:8118");
    expect(env.npm_config_https_proxy).toBe("http://10.0.0.2:8118");
  });
});

describe("egressNetworkCreateArgs (the podman-native internal network)", () => {
  it("creates an --internal network (no external route — the hard confinement)", () => {
    const args = egressNetworkCreateArgs();
    expect(args[0]).toBe("network");
    expect(args[1]).toBe("create");
    expect(args).toContain("--internal");
    expect(args).toContain(EGRESS_NETWORK);
  });
});

describe("proxyContainerRunArgs (dual-homed proxy: internal + external)", () => {
  it("runs the proxy attached to BOTH the internal egress net and an external net", () => {
    const args = proxyContainerRunArgs({
      image: "docker.io/library/node:20-alpine",
      externalNetwork: "podman",
      allowlist: ["registry.npmjs.org", "github.com"],
      proxyEntrypoint: "/opt/dustcastle/proxy-main.js",
    });
    expect(args[0]).toBe("run");
    // Dual-homed: reachable by the sandbox on the internal net, but the only
    // member of it that can also reach the outside world.
    expect(args).toContain(EGRESS_NETWORK);
    expect(args).toContain("podman");
    expect(args.join(" ")).toContain(`--name ${EGRESS_PROXY_CONTAINER}`.split(" ").join(" "));
    // The allowlist + port travel as env to the proxy entrypoint.
    expect(args.join(" ")).toContain("registry.npmjs.org,github.com");
    expect(args.join(" ")).toContain(String(EGRESS_PROXY_PORT));
    expect(args).toContain("/opt/dustcastle/proxy-main.js");
  });
});

describe("productionProxyUrl (how a sandbox addresses the proxy)", () => {
  it("addresses the proxy container by name on the internal net", () => {
    expect(productionProxyUrl()).toBe(`http://${EGRESS_PROXY_CONTAINER}:${EGRESS_PROXY_PORT}`);
  });
});

describe("confineRouteScript (the privilege-stripped-host fallback — pasta route-strip)", () => {
  it("adds a host route to the proxy then drops the default route (proxy = only egress)", () => {
    const script = confineRouteScript("169.254.7.7");
    // A /32 host route to the proxy address, on the auto-detected default device.
    expect(script).toContain("169.254.7.7/32");
    // Then the default route is removed — nothing else is reachable.
    expect(script).toMatch(/route\s+del\s+default/);
    // Device is detected from the existing default route, not hard-coded eth0.
    expect(script).toContain("default");
  });
});
