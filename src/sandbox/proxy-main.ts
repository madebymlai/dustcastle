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
import { startEgressProxy } from "./proxy.js";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const allowlist = (env.DUSTCASTLE_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const port = Number(env.DUSTCASTLE_EGRESS_PORT ?? "8118");
  const host = env.DUSTCASTLE_EGRESS_HOST ?? "127.0.0.1";

  const proxy = await startEgressProxy({
    allowlist,
    port,
    host,
    onDecision: (h, allowed) =>
      process.stderr.write(`dustcastle-egress: ${allowed ? "ALLOW" : "DENY "} ${h}\n`),
  });
  process.stderr.write(
    `dustcastle-egress: listening on ${proxy.url}; allowlist=[${allowlist.join(", ")}]\n`,
  );
}

// Run when invoked directly (production container / e2e host process).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`dustcastle-egress: ${String(err)}\n`);
    process.exit(1);
  });
}
