/**
 * Egress confinement (ADR 0005) — the layer that makes the filtering proxy
 * (`./proxy.ts`) the ONLY way an impure `allow` build can reach the network.
 * Two backends, same proxy:
 *
 *  - **Production (podman-native, host-OS-agnostic).** A `--internal` podman
 *    network has no route off-host; a dual-homed proxy container sits on both
 *    that internal net and a normal external net, so the sandbox can reach *only*
 *    the proxy, and the proxy enforces the allowlist. Expressed entirely in
 *    podman terms, so it runs the same on Linux / macOS / Windows podman.
 *  - **Privilege-stripped-host fallback (the live e2e).** Where the host's
 *    rootless podman can't create a bridge (no module / no root), the sandbox is
 *    confined by stripping its default route and leaving a single host route to a
 *    host-side proxy (reached via pasta's host-loopback mapping). Same proxy,
 *    same guarantee, provable on this machine.
 *
 * Only the pure spec generators live here (unit-tested); the imperative podman
 * invocations run live on a capable host / in the gated e2e.
 */

/** The internal podman network an impure build attaches to (production backend). */
export const EGRESS_NETWORK = "dustcastle-egress";
/** The dual-homed filtering-proxy container's name (resolvable via aardvark-dns). */
export const EGRESS_PROXY_CONTAINER = "dustcastle-egress-proxy";
/** The port the proxy listens on (both backends). */
export const EGRESS_PROXY_PORT = 8118;

/** Point a build's HTTP tooling (and npm) at the egress proxy. */
export function proxyEnv(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_https_proxy: proxyUrl,
  };
}

/** How a sandbox addresses the production proxy: by container name on the internal net. */
export function productionProxyUrl(): string {
  return `http://${EGRESS_PROXY_CONTAINER}:${EGRESS_PROXY_PORT}`;
}

/**
 * `podman network create` args for the internal egress network. `--internal`
 * gives it no route off-host: a sandbox on it cannot reach the outside world at
 * all — only other members (the proxy). This is the hard confinement; the proxy
 * is the single, allowlist-gated escape hatch.
 */
export function egressNetworkCreateArgs(network: string = EGRESS_NETWORK): string[] {
  return ["network", "create", "--internal", network];
}

export interface ProxyContainerSpec {
  /** Image carrying a Node runtime to run the proxy entrypoint. */
  readonly image: string;
  /** The external (internet-facing) network the proxy also attaches to. */
  readonly externalNetwork: string;
  /** The derived allowlist this proxy will enforce. */
  readonly allowlist: readonly string[];
  /** In-container path to the proxy entrypoint (`proxy-main.js`). */
  readonly proxyEntrypoint: string;
  /** Override the proxy container name / internal network / port (tests). */
  readonly container?: string;
  readonly network?: string;
  readonly port?: number;
}

/**
 * `podman run` args for the dual-homed filtering proxy: attached to BOTH the
 * internal egress net (so the sandbox can reach it) and an external net (so it,
 * alone, can reach the allowlisted registries). The allowlist + port are passed
 * as env to the entrypoint.
 */
export function proxyContainerRunArgs(spec: ProxyContainerSpec): string[] {
  const network = spec.network ?? EGRESS_NETWORK;
  const container = spec.container ?? EGRESS_PROXY_CONTAINER;
  const port = spec.port ?? EGRESS_PROXY_PORT;
  return [
    "run",
    "-d",
    "--name",
    container,
    "--network",
    network,
    "--network",
    spec.externalNetwork,
    "-e",
    `DUSTCASTLE_EGRESS_ALLOWLIST=${spec.allowlist.join(",")}`,
    "-e",
    `DUSTCASTLE_EGRESS_PORT=${port}`,
    spec.image,
    "node",
    spec.proxyEntrypoint,
  ];
}

export interface ConfineRouteOptions {
  /** The proxy port to keep reachable (kept for symmetry; a /32 route covers any port). */
  readonly proxyPort?: number;
}

/**
 * The in-container shell (privilege-stripped-host fallback) that confines the
 * sandbox to the proxy: add a single /32 host route to the proxy address on the
 * auto-detected default device, then delete the default route. After this the
 * container can reach the proxy and *nothing else* — a raw socket to any other
 * address has no route. Requires `--cap-add NET_ADMIN`. The device is read from
 * the existing default route (pasta copies the host iface name, e.g. `wlan0`),
 * never hard-coded.
 */
export function confineRouteScript(proxyAddr: string, _opts: ConfineRouteOptions = {}): string {
  return [
    "set -e",
    'DEV=$(ip route | awk "/default/ {print \\$5; exit}")',
    `ip route add ${proxyAddr}/32 dev "$DEV"`,
    "ip route del default",
  ].join("\n");
}
