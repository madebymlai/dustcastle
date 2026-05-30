import { describe, expect, it } from "vitest";
import { EGRESS_NETWORK, EGRESS_PROXY_CONTAINER, productionProxyUrl } from "./confine.js";
import type { EgressDecision } from "./egress.js";
import { ensureEgress, type PodmanResult } from "./egress-runtime.js";

/** A structured allowlist decision (ADR 0010): Build hosts + optional Agent hosts. */
const allow = (buildHosts: string[], agentHosts: string[] = []): EgressDecision => ({
  kind: "allowlist",
  buildHosts,
  agentHosts,
});

// The imperative glue that brings up the production egress backend (ADR 0005,
// handoff item 1-tail): an --internal network with no route off-host + a
// dual-homed filtering-proxy container, created before sandcastle.run() and torn
// down after. This host can't make a bridge network, so the orchestration is
// driven through an injected podman runner and the COMMAND SEQUENCE is asserted;
// the live run is gated for a capable host.

const OK: PodmanResult = { status: 0, stderr: "" };

function recorder(reply: (args: string[]) => PodmanResult = () => OK) {
  const calls: string[][] = [];
  const run = (args: readonly string[]): PodmanResult => {
    const a = [...args];
    calls.push(a);
    return reply(a);
  };
  return { run, calls };
}

describe("ensureEgress (the production egress backend orchestration — ADR 0005)", () => {
  it("is a no-op on the closed/pure path (no network, no proxy)", () => {
    const { run, calls } = recorder();
    const handle = ensureEgress({ egress: { kind: "none" }, proxyEntrypoint: "/p.js", run });
    expect(calls).toEqual([]);
    expect(handle.proxyUrl).toBeUndefined();
    handle.teardown(); // must not throw
    expect(calls).toEqual([]);
  });

  it("creates the internal network then starts the dual-homed proxy, in order", () => {
    const { run, calls } = recorder();
    const handle = ensureEgress({
      egress: allow(["registry.npmjs.org", "github.com"]),
      proxyEntrypoint: "/opt/dustcastle/proxy-main.js",
      run,
    });
    // First: the --internal network (the hard confinement — no route off-host).
    expect(calls[0]!.slice(0, 2)).toEqual(["network", "create"]);
    expect(calls[0]).toContain("--internal");
    expect(calls[0]).toContain(EGRESS_NETWORK);
    // Then: a `podman run` of the proxy carrying the derived allowlist + entrypoint.
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall!.join(" ")).toContain("registry.npmjs.org,github.com");
    expect(runCall!).toContain("/opt/dustcastle/proxy-main.js");
    // Network create precedes the proxy run.
    expect(calls.indexOf(runCall!)).toBeGreaterThan(0);
    // The sandbox addresses the proxy by its production URL (matches the plan).
    expect(handle.proxyUrl).toBe(productionProxyUrl());
  });

  it("enforces the deduped Build∪Agent allowlist on the proxy (ADR 0010)", () => {
    const { run, calls } = recorder();
    // A host shared by build and agent must reach the proxy exactly once.
    const handle = ensureEgress({
      egress: { kind: "allowlist", buildHosts: ["github.com"], agentHosts: ["github.com", "api.deepseek.com"] },
      proxyEntrypoint: "/p.js",
      run,
    });
    const runCall = calls.find((c) => c[0] === "run");
    expect(runCall!.join(" ")).toContain("github.com,api.deepseek.com");
    // github.com appears once, not twice — the union is deduped.
    expect(runCall!.join(" ")).not.toContain("github.com,github.com");
    expect(handle.proxyUrl).toBe(productionProxyUrl());
  });

  it("tolerates an already-existing network (idempotent re-run)", () => {
    const { run } = recorder((a) =>
      a[0] === "network" && a[1] === "create"
        ? { status: 125, stderr: "Error: network dustcastle-egress already exists" }
        : OK,
    );
    const handle = ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      proxyEntrypoint: "/p.js",
      run,
    });
    expect(handle.proxyUrl).toBe(productionProxyUrl());
  });

  it("throws on a hard network-create failure (not an already-exists)", () => {
    const { run } = recorder((a) =>
      a[0] === "network" && a[1] === "create"
        ? { status: 125, stderr: "bridge: operation not permitted" }
        : OK,
    );
    expect(() =>
      ensureEgress({ egress: allow(["x"]), proxyEntrypoint: "/p.js", run }),
    ).toThrow(/egress network/i);
  });

  it("rolls back the freshly-created network when the proxy fails to start", () => {
    const { run, calls } = recorder((a) => (a[0] === "run" ? { status: 1, stderr: "no such image" } : OK));
    expect(() =>
      ensureEgress({ egress: allow(["x"]), proxyEntrypoint: "/p.js", run }),
    ).toThrow(/proxy/i);
    // A failed setup leaves nothing behind: the network we created is removed.
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });

  it("teardown removes the proxy container and the network", () => {
    const { run, calls } = recorder();
    const handle = ensureEgress({
      egress: allow(["x"]),
      proxyEntrypoint: "/p.js",
      run,
    });
    calls.length = 0; // isolate the teardown calls
    handle.teardown();
    expect(calls.some((c) => c[0] === "rm" && c.includes(EGRESS_PROXY_CONTAINER))).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });
});
