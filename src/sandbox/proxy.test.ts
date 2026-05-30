import { createServer, type Server, type Socket, connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isHostAllowed, startEgressProxy, type EgressProxyHandle } from "./proxy.js";

// The allowlist-filtering egress proxy (ADR 0005). This is the portable security
// brain that ENFORCES the derived allowlist: an impure `allow` build's untrusted
// install code reaches the proxy and nothing else, and the proxy tunnels only the
// allowlisted hosts (the registry + git host) and refuses everything else. The
// same code runs in production (a dual-homed proxy container on the internal
// network) and in the live e2e (a host process behind the pasta route-strip), so
// proving it here proves the real guarantee.

describe("isHostAllowed (the allowlist matcher — exact, never wildcard)", () => {
  it("allows an exactly-listed host", () => {
    expect(isHostAllowed("registry.npmjs.org", ["registry.npmjs.org"])).toBe(true);
  });

  it("is case-insensitive and ignores a port suffix", () => {
    expect(isHostAllowed("Registry.NPMJS.org:443", ["registry.npmjs.org"])).toBe(true);
  });

  it("denies a host not on the list", () => {
    expect(isHostAllowed("evil.example.com", ["registry.npmjs.org", "github.com"])).toBe(false);
  });

  it("denies everything when the allowlist is empty", () => {
    expect(isHostAllowed("registry.npmjs.org", [])).toBe(false);
  });

  it("does not treat the allowlist entry as a suffix wildcard (no sub/sibling match)", () => {
    // "npmjs.org" must NOT match "registry.npmjs.org", nor must a listed host
    // match an attacker-controlled lookalike like "registry.npmjs.org.evil.com".
    expect(isHostAllowed("registry.npmjs.org.evil.com", ["registry.npmjs.org"])).toBe(false);
    expect(isHostAllowed("notregistry.npmjs.org", ["registry.npmjs.org"])).toBe(false);
  });
});

describe("startEgressProxy (live CONNECT tunneling, allowlist-enforced)", () => {
  let proxy: EgressProxyHandle | undefined;
  let target: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    proxy = undefined;
    if (target) await new Promise<void>((r) => target!.close(() => r()));
    target = undefined;
  });

  // A loopback origin server standing in for "the registry" — the proxy tunnels
  // raw bytes to it, so a successful CONNECT yields this banner end-to-end.
  async function startTarget(): Promise<number> {
    target = createServer((sock: Socket) => {
      sock.on("data", () => {});
      sock.end("ORIGIN_OK\n");
    });
    await new Promise<void>((r) => target!.listen(0, "127.0.0.1", () => r()));
    return (target!.address() as { port: number }).port;
  }

  // Issue a raw CONNECT through the proxy; resolve with the proxy's status line
  // and (if the tunnel opened) the first bytes the origin sent back.
  function connectThroughProxy(
    proxyPort: number,
    hostPort: string,
  ): Promise<{ status: string; body: string }> {
    return new Promise((resolve, reject) => {
      const sock = netConnect(proxyPort, "127.0.0.1", () => {
        sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
      });
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
      });
      sock.on("end", () => {
        const status = buf.split("\r\n", 1)[0] ?? "";
        const body = buf.includes("ORIGIN_OK") ? "ORIGIN_OK" : "";
        resolve({ status, body });
      });
      sock.on("error", reject);
      setTimeout(() => {
        sock.destroy();
        resolve({ status: buf.split("\r\n", 1)[0] ?? "", body: buf.includes("ORIGIN_OK") ? "ORIGIN_OK" : "" });
      }, 2000);
    });
  }

  it("tunnels a CONNECT to an allowlisted host through to the origin", async () => {
    const port = await startTarget();
    proxy = await startEgressProxy({ allowlist: ["127.0.0.1"] });
    const res = await connectThroughProxy(proxy.port, `127.0.0.1:${port}`);
    expect(res.status).toMatch(/200/);
    expect(res.body).toBe("ORIGIN_OK");
  });

  it("refuses a CONNECT to an off-allowlist host with 403 and no tunnel", async () => {
    const port = await startTarget();
    proxy = await startEgressProxy({ allowlist: ["registry.npmjs.org"] });
    const res = await connectThroughProxy(proxy.port, `127.0.0.1:${port}`);
    expect(res.status).toMatch(/403/);
    expect(res.body).toBe("");
  });

  it("records each decision for auditability (never silent — ADR 0005)", async () => {
    const port = await startTarget();
    const decisions: Array<{ host: string; allowed: boolean }> = [];
    proxy = await startEgressProxy({
      allowlist: ["127.0.0.1"],
      onDecision: (host, allowed) => decisions.push({ host, allowed }),
    });
    await connectThroughProxy(proxy.port, `127.0.0.1:${port}`);
    await connectThroughProxy(proxy.port, `blocked.example.com:443`);
    expect(decisions).toContainEqual({ host: "127.0.0.1", allowed: true });
    expect(decisions).toContainEqual({ host: "blocked.example.com", allowed: false });
    expect(proxy.denied).toContain("blocked.example.com");
  });

  it("exposes a loopback url for the proxy", async () => {
    proxy = await startEgressProxy({ allowlist: [] });
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
  });
});
