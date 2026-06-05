import { connect, type Socket } from "node:net";
import { createServer, type IncomingMessage, type Server } from "node:http";

/**
 * The allowlist-filtering egress proxy (ADR 0005) — dustcastle's enforcement of
 * the *derived* egress allowlist. An impure `allow` build runs untrusted install
 * code *with* network; confinement (a podman internal network in production, a
 * pasta route-strip in the live e2e) makes this proxy the build's ONLY way out,
 * and the proxy tunnels only the allowlisted hosts (the registry + git host),
 * refusing everything else with a 403. This is what turns "a compromised dep can
 * exfiltrate anywhere" into "it can reach the registries it was going to anyway."
 *
 * It is a CONNECT proxy: it does NOT terminate TLS (no MITM, no certs) — it
 * checks the requested host against the allowlist, then blindly pipes bytes to an
 * allowed origin. The same code is the production enforcer and the e2e's live
 * proof, so it is fully portable: plain Node, no privileges, no OS specifics.
 */
export interface EgressProxyHandle {
  /** The TCP port the proxy listens on (ephemeral by default). */
  readonly port: number;
  /** The proxy URL to hand clients as HTTP(S)_PROXY (loopback bind). */
  readonly url: string;
  /** Hosts that were refused — surfaced for auditing (never silent, ADR 0005). */
  readonly denied: readonly string[];
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  /** The derived allowlist (confine().decision flattened) — the only hosts that may be reached. */
  readonly allowlist: readonly string[];
  /** Listen port (default 0 → ephemeral). */
  readonly port?: number;
  /** Bind address (default 127.0.0.1; the e2e maps this into the container). */
  readonly host?: string;
  /** Observe each allow/deny decision (auditing). */
  readonly onDecision?: (host: string, allowed: boolean) => void;
}

/**
 * Whether a requested host is on the allowlist (ADR 0005). Exact match only,
 * case-insensitive, port-insensitive — never a suffix/wildcard match, so a
 * listed `registry.npmjs.org` can never be satisfied by `registry.npmjs.org.evil
 * .com` or a sibling subdomain. Strictness is the whole point.
 */
export function isHostAllowed(host: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeHost(host);
  return allowlist.some((entry) => normalizeHost(entry) === normalized);
}

function normalizeHost(host: string): string {
  // Drop a :port suffix (but not the host itself) and lowercase.
  const withoutPort = host.replace(/:\d+$/, "");
  return withoutPort.trim().toLowerCase();
}

/**
 * Start the filtering proxy (ADR 0005). Resolves once it is listening. Handles
 * HTTPS via the HTTP `CONNECT` method (the path npm/git use) and plain HTTP
 * forward requests; both are allowlist-gated identically.
 */
export function startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxyHandle> {
  const host = opts.host ?? "127.0.0.1";
  const denied: string[] = [];

  const decide = (target: string): boolean => {
    const allowed = isHostAllowed(target, opts.allowlist);
    if (!allowed && !denied.includes(normalizeHost(target))) denied.push(normalizeHost(target));
    opts.onDecision?.(normalizeHost(target), allowed);
    return allowed;
  };

  const server: Server = createServer((req, res) => {
    // Plain HTTP forward proxy: the absolute-form URL names the host.
    const target = hostFromHttpRequest(req);
    if (target === undefined || !decide(target)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("dustcastle egress: host not on allowlist\n");
      return;
    }
    const url = new URL(req.url ?? "");
    const upstream = connect(Number(url.port) || 80, url.hostname, () => {
      upstream.write(
        `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\nhost: ${url.host}\r\n` +
          rebuildHeaders(req) +
          "\r\n",
      );
      req.pipe(upstream);
      upstream.pipe(res.socket!);
    });
    upstream.on("error", () => res.destroy());
  });

  // HTTPS tunneling: CONNECT host:port — allowlist-gate, then pipe raw bytes.
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const target = req.url ?? "";
    const [hostname, portStr] = splitHostPort(target);
    if (!decide(hostname)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      clientSocket.end();
      return;
    }
    const upstream = connect(Number(portStr) || 443, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
      clientSocket.end();
    });
    clientSocket.on("error", () => upstream.destroy());
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        url: `http://${host}:${port}`,
        denied,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

/** The host:port a CONNECT request targets, split into parts. */
function splitHostPort(hostPort: string): [string, string] {
  const idx = hostPort.lastIndexOf(":");
  if (idx === -1) return [hostPort, ""];
  return [hostPort.slice(0, idx), hostPort.slice(idx + 1)];
}

/** The destination host of a plain-HTTP forward request (absolute URL or Host). */
function hostFromHttpRequest(req: IncomingMessage): string | undefined {
  const url = req.url ?? "";
  if (url.startsWith("http://")) {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  }
  const hostHeader = req.headers.host;
  return hostHeader ? normalizeHost(hostHeader) : undefined;
}

/** Re-emit a forwarded request's headers (minus the proxy-managed host). */
function rebuildHeaders(req: IncomingMessage): string {
  const out: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i]!;
    if (key.toLowerCase() === "host") continue;
    out.push(`${key}: ${req.rawHeaders[i + 1]}\r\n`);
  }
  return out.join("");
}
