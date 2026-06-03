/**
 * Runnable entrypoint for the egress proxy (ADR 0005). Reads the derived
 * allowlist + port from the environment and starts the filtering proxy. The same
 * entrypoint runs in the production proxy *container* (dual-homed on the internal
 * egress net) and as the host-side process the live e2e confines the sandbox to.
 *
 *   DUSTCASTLE_EGRESS_ALLOWLIST=registry.npmjs.org,github.com
 *   DUSTCASTLE_EGRESS_PORT=8118
 *   DUSTCASTLE_EGRESS_HOST=0.0.0.0   (default 127.0.0.1)
 */
import type { Logger } from "../log/index.js";
import { startEgressProxy, type EgressProxyHandle } from "./proxy.js";
import { createProxyLogger } from "./proxy-logger.js";

export interface ProxyMainEnv {
  readonly DUSTCASTLE_EGRESS_ALLOWLIST?: string;
  readonly DUSTCASTLE_EGRESS_PORT?: string;
  readonly DUSTCASTLE_EGRESS_HOST?: string;
}

export async function main(
  env: ProxyMainEnv = process.env,
  logger: Logger = createProxyLogger().child({ mod: "egress-proxy" }),
): Promise<EgressProxyHandle> {
  const allowlist = allowlistFromEnv(env);
  const port = Number(env.DUSTCASTLE_EGRESS_PORT ?? "8118");
  const host = env.DUSTCASTLE_EGRESS_HOST ?? "127.0.0.1";

  const proxy = await startEgressProxy({
    allowlist,
    port,
    host,
    onDecision: (targetHost, allowed) =>
      logger.info({ decision: allowed ? "allow" : "deny", host: targetHost }, "egress decision"),
  });
  logger.info({ event: "listening", port: proxy.port }, "proxy listening");
  return proxy;
}

function allowlistFromEnv(env: ProxyMainEnv): string[] {
  return (env.DUSTCASTLE_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
}

/** Injectable seam for {@link installShutdownHandlers} so the wiring is unit-tested. */
export interface ShutdownHooks {
  readonly on?: (signal: NodeJS.Signals, handler: () => void) => void;
  readonly exit?: (code: number) => void;
  readonly signals?: readonly NodeJS.Signals[];
}

/**
 * Close the proxy and exit promptly on SIGTERM/SIGINT. The proxy runs as PID 1 in
 * its container, and the kernel applies NO default signal disposition to PID 1 — so
 * without an explicit handler, SIGTERM is a no-op and `podman stop`/`rm -f` waits the
 * full ~10s stop-timeout before SIGKILL. Closing the server on the signal lets the
 * container stop in well under a second (clean exit 0, not a 137 hard-kill).
 */
export function installShutdownHandlers(proxy: EgressProxyHandle, logger: Logger, hooks: ShutdownHooks = {}): void {
  const on = hooks.on ?? ((signal, handler) => void process.on(signal, handler));
  const exit = hooks.exit ?? ((code) => process.exit(code));
  const signals = hooks.signals ?? (["SIGTERM", "SIGINT"] as const);
  for (const signal of signals) {
    on(signal, () => {
      logger.info({ event: "shutdown", signal }, "egress proxy shutting down");
      proxy
        .close()
        .then(() => exit(0))
        .catch(() => exit(0));
    });
  }
}

// Run when invoked directly (production container / e2e host process).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const logger = createProxyLogger().child({ mod: "egress-proxy" });
  main(process.env, logger)
    .then((proxy) => installShutdownHandlers(proxy, logger))
    .catch((err) => {
      logger.error({ err }, "egress proxy failed");
      process.exit(1);
    });
}
