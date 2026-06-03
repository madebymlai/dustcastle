import { createServer, type AddressInfo, type Server, type Socket, connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { installShutdownHandlers, main } from "./proxy-main.js";
import type { EgressProxyHandle } from "./proxy.js";

const TEST_ENV = {
  DUSTCASTLE_EGRESS_ALLOWLIST: "127.0.0.1",
  DUSTCASTLE_EGRESS_PORT: "0",
  DUSTCASTLE_EGRESS_HOST: "127.0.0.1",
};

describe("proxy-main structured logging", () => {
  let proxy: EgressProxyHandle | undefined;
  let target: Server | undefined;

  afterEach(async () => {
    if (proxy) await proxy.close();
    proxy = undefined;
    if (target) await new Promise<void>((resolve) => target!.close(() => resolve()));
    target = undefined;
  });

  it("emits JSON-ready structured listening and allow/deny decision records through the Logger port", async () => {
    const root = createMemoryLogger();
    proxy = await main(TEST_ENV, root.child({ mod: "egress-proxy" }));

    const port = await startTarget();
    await connectThroughProxy(proxy.port, `127.0.0.1:${port}`);
    await connectThroughProxy(proxy.port, "blocked.example.com:443");

    expect(root.records).toContainEqual({
      level: "info",
      fields: { mod: "egress-proxy", event: "listening", port: proxy.port },
      msg: "proxy listening",
      args: [],
    });
    expect(root.records).toContainEqual({
      level: "info",
      fields: { mod: "egress-proxy", decision: "allow", host: "127.0.0.1" },
      msg: "egress decision",
      args: [],
    });
    expect(root.records).toContainEqual({
      level: "info",
      fields: { mod: "egress-proxy", decision: "deny", host: "blocked.example.com" },
      msg: "egress decision",
      args: [],
    });
  });

  // Regression (egress standup/teardown latency): the proxy is PID 1 in its
  // container, which the kernel gives no default SIGTERM disposition — so without an
  // explicit handler `podman stop`/`rm -f` blocks the full ~10s stop-timeout then
  // SIGKILLs (exit 137). This locks in the handler that closes + exits on the signal.
  // (PID-1 kernel semantics themselves are container-only; the live proof is the
  // diagnose experiment, not this unit seam.)
  it("installShutdownHandlers closes the proxy and exits 0 on SIGTERM/SIGINT", async () => {
    let closed = false;
    let exitCode: number | undefined;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const fakeProxy = { port: 8118, close: async () => { closed = true; } } as EgressProxyHandle;

    installShutdownHandlers(fakeProxy, createMemoryLogger(), {
      on: (signal, handler) => handlers.set(signal, handler),
      exit: (code) => { exitCode = code; },
    });

    expect([...handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    handlers.get("SIGTERM")!(); // simulate the signal
    await new Promise((resolve) => setImmediate(resolve)); // let close().then() settle
    expect(closed).toBe(true);
    expect(exitCode).toBe(0);
  });

  async function startTarget(): Promise<number> {
    target = createServer((sock: Socket) => {
      sock.on("data", () => {});
      sock.end("ORIGIN_OK\n");
    });
    await new Promise<void>((resolve) => target!.listen(0, "127.0.0.1", () => resolve()));
    return (target!.address() as AddressInfo).port;
  }

  function connectThroughProxy(proxyPort: number, hostPort: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = netConnect(proxyPort, "127.0.0.1", () => {
        sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
      });
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        sock.destroy();
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        sock.destroy();
        reject(err);
      };

      sock.on("data", () => {});
      sock.on("end", finish);
      sock.on("error", fail);
      timeout = setTimeout(finish, 2000);
    });
  }
});
