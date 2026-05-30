/**
 * The imperative orchestration of the production egress backend (ADR 0005 —
 * handoff item 1-tail). `confine.ts` holds the pure spec generators; this is the
 * glue that actually runs them: on the impure `allow` path, create the
 * `--internal` egress network (no route off-host) and start the dual-homed
 * filtering-proxy container before `sandcastle.run()`, then tear both down after.
 *
 * Kept behind an injectable podman runner so the command sequence is unit-tested
 * on hosts that can't create a bridge network (this one). The live run is gated
 * for a capable host; the security-critical proxy itself is proven live by the
 * slice-3 fallback e2e.
 */

import { spawnSync } from "node:child_process";
import {
  EGRESS_NETWORK,
  EGRESS_PROXY_CONTAINER,
  egressNetworkCreateArgs,
  productionProxyUrl,
  proxyContainerRunArgs,
} from "./confine.js";
import { egressHosts, type EgressDecision } from "./egress.js";

/** The minimal result of a podman invocation the orchestration reasons about. */
export interface PodmanResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real spawn. */
export type PodmanRunner = (args: readonly string[]) => PodmanResult;

/** A stock Node image is enough to run the proxy entrypoint (deployment may override). */
const DEFAULT_PROXY_IMAGE = "docker.io/library/node:20-alpine";
/** The external (internet-facing) network the proxy is also homed on. */
const DEFAULT_EXTERNAL_NETWORK = "podman";

export interface EnsureEgressOptions {
  /** The plan's egress decision; only the allowlist path provisions anything. */
  readonly egress: EgressDecision;
  /** In-container path to the proxy entrypoint (`proxy-main.js`). */
  readonly proxyEntrypoint: string;
  /** Image carrying a Node runtime for the proxy container. */
  readonly image?: string;
  /** The external network the proxy reaches the allowlisted registries through. */
  readonly externalNetwork?: string;
  /** Inject a podman runner (tests); defaults to a real `podman` spawn. */
  readonly run?: PodmanRunner;
  /** Surface progress lines (never silent — ADR 0005). */
  readonly onLine?: (line: string) => void;
}

/** A handle to the live egress infra: how to address the proxy, and how to remove it. */
export interface EgressHandle {
  /** The URL the sandbox routes its tooling through. Undefined on the closed path. */
  readonly proxyUrl?: string;
  /** Idempotent, best-effort teardown of the proxy container + network. */
  readonly teardown: () => void;
}

const NOOP: EgressHandle = { teardown: () => {} };

/**
 * Bring up (or confirm) the production egress backend for a plan's egress
 * decision. No-op on the closed/pure path. On the allowlist path: idempotently
 * create the internal network, then start the dual-homed proxy enforcing exactly
 * the derived allowlist. Throws if the infra can't be established (rolling back a
 * network it created), so a failed setup never leaves the sandbox a way out.
 */
export function ensureEgress(opts: EnsureEgressOptions): EgressHandle {
  if (opts.egress.kind !== "allowlist") return NOOP; // closed/pure: no network, no proxy
  const run = opts.run ?? defaultPodman;
  const log = opts.onLine ?? (() => {});
  // The proxy enforces the deduped union of Build + Agent Egress (ADR 0010).
  const hosts = egressHosts(opts.egress);

  // 1. The internal network — no route off-host. Idempotent: a prior run may have
  //    left it, which is fine; only a *different* failure is fatal.
  const created = run(egressNetworkCreateArgs());
  const weCreatedNetwork = isOk(created);
  if (!weCreatedNetwork && !isAlreadyExists(created)) {
    throw new Error(
      `dustcastle: could not create egress network ${EGRESS_NETWORK}: ${created.stderr.trim()}`,
    );
  }
  log(`egress: internal network ${EGRESS_NETWORK} ready`);

  // 2. Clear a stale proxy from a prior run (best-effort), then start the
  //    dual-homed proxy: it alone bridges the internal net to the outside world.
  run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
  const started = run(
    proxyContainerRunArgs({
      image: opts.image ?? DEFAULT_PROXY_IMAGE,
      externalNetwork: opts.externalNetwork ?? DEFAULT_EXTERNAL_NETWORK,
      allowlist: hosts,
      proxyEntrypoint: opts.proxyEntrypoint,
    }),
  );
  if (!isOk(started)) {
    if (weCreatedNetwork) run(["network", "rm", EGRESS_NETWORK]); // roll back our own network
    throw new Error(`dustcastle: could not start egress proxy: ${started.stderr.trim()}`);
  }
  log(`egress: proxy ${EGRESS_PROXY_CONTAINER} enforcing allowlist [${hosts.join(", ")}]`);

  return {
    proxyUrl: productionProxyUrl(),
    teardown: () => {
      run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
      run(["network", "rm", EGRESS_NETWORK]);
    },
  };
}

function isOk(r: PodmanResult): boolean {
  return r.status === 0;
}

/** podman reports an existing network/container as "already exists" / "already in use". */
function isAlreadyExists(r: PodmanResult): boolean {
  return /already exists|already in use/i.test(r.stderr);
}

function defaultPodman(args: readonly string[]): PodmanResult {
  const r = spawnSync("podman", [...args], { encoding: "utf8" });
  const stderr = r.stderr ?? (r.error instanceof Error ? r.error.message : "");
  return { status: r.status, stderr };
}
