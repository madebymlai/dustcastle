import { createServer, type AddressInfo, type Server, type Socket, connect as netConnect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryLogger } from "../log/fake.js";
import { main } from "./proxy-main.js";
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
