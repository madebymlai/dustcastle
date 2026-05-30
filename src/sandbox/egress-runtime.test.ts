import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EGRESS_NETWORK, EGRESS_PROXY_CONTAINER, productionProxyUrl } from "./confine.js";
import type { EgressDecision } from "./egress.js";
import { ensureEgress, provisionProxyResolvConf, type PodmanResult } from "./egress-runtime.js";

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

/** A proxy whose logs report it is serving — the liveness probe's success signal. */
const LIVE_LOGS: PodmanResult = {
  status: 0,
  stderr: "dustcastle-egress: listening on http://0.0.0.0:8118; allowlist=[x]\n",
};

/** Default replies: ordinary commands succeed, and the liveness probe sees a live proxy. */
function defaultReply(args: string[]): PodmanResult {
  if (args[0] === "logs") return LIVE_LOGS;
  return OK;
}

function recorder(reply: (args: string[]) => PodmanResult = defaultReply) {
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
        : defaultReply(a),
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

  it("throws (and rolls back) when the proxy is created but crashes — never a silent success", () => {
    // `podman run -d` exits 0 (container CREATED) but the process dies a moment later
    // because the image lacks the proxy code — the exact ADR-0005 "never silent" trap.
    const { run, calls } = recorder((a) => {
      if (a[0] === "logs")
        return { status: 0, stderr: "Error: Cannot find module '/opt/dustcastle/proxy-main.js'\n" };
      if (a[0] === "inspect") return { status: 0, stdout: "false\n", stderr: "" };
      return OK; // network create + `run -d` both "succeed"
    });
    expect(() =>
      ensureEgress({ egress: allow(["api.deepseek.com"]), proxyEntrypoint: "/opt/dustcastle/proxy-main.js", run }),
    ).toThrow(/proxy container started but is not serving[\s\S]*Cannot find module/i);
    // A dead proxy leaves nothing behind: container removed, our network rolled back.
    expect(calls.some((c) => c[0] === "rm" && c.includes(EGRESS_PROXY_CONTAINER))).toBe(true);
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm" && c.includes(EGRESS_NETWORK))).toBe(true);
  });

  it("bind-mounts the resolv.conf path onto the proxy run when supplied", () => {
    const { run, calls } = recorder();
    ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      proxyEntrypoint: "/p.js",
      resolvConfPath: "/h/.dustcastle/egress-resolv.conf",
      run,
    });
    const runCall = calls.find((c) => c[0] === "run")!;
    expect(runCall.join(" ")).toContain("/h/.dustcastle/egress-resolv.conf:/etc/resolv.conf:ro");
  });

  it("accepts the proxy once its logs report it is listening (liveness confirmed)", () => {
    const { run } = recorder(); // default reply: logs report the proxy is serving
    const handle = ensureEgress({
      egress: allow(["registry.npmjs.org"]),
      proxyEntrypoint: "/p.js",
      run,
    });
    expect(handle.proxyUrl).toBe(productionProxyUrl());
  });

  it("provisionProxyResolvConf writes external resolvers (not the --internal aardvark)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dc-resolv-"));
    try {
      const path = provisionProxyResolvConf(dir);
      expect(path).toBe(join(dir, "egress-resolv.conf"));
      const body = readFileSync(path, "utf8");
      expect(body).toContain("nameserver 1.1.1.1");
      // Idempotent: a second call rewrites the same file cleanly.
      expect(provisionProxyResolvConf(dir)).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
