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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DUSTCASTLE_HOME } from "../config/global.js";
import { noopLogger, type Logger } from "../log/index.js";
import {
  EGRESS_NETWORK,
  EGRESS_PROXY_CONTAINER,
  egressNetworkCreateArgs,
  productionProxyUrl,
  proxyContainerRunArgs,
  proxyResolvConf,
} from "./confine.js";
import { egressHosts, type EgressDecision } from "./egress.js";
import { PROXY_SPEC } from "./image.js";

/** The minimal result of a podman invocation the orchestration reasons about. */
export interface PodmanResult {
  readonly status: number | null;
  readonly stderr: string;
  /** Captured stdout (e.g. `podman inspect -f` template output); "" when unused. */
  readonly stdout?: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real spawn. */
export type PodmanRunner = (args: readonly string[]) => PodmanResult;

/**
 * The dustcastle-owned proxy image (ensureImage builds it from PROXY_SPEC). NOT stock
 * node:20-alpine: that image has no `/opt/dustcastle/proxy-main.js`, so the proxy
 * container crashed on start and the allowlist was enforced over a dead proxy.
 */
const DEFAULT_PROXY_IMAGE = PROXY_SPEC.tag;
/** The external (internet-facing) network the proxy is also homed on. */
const DEFAULT_EXTERNAL_NETWORK = "podman";

/** The JSON event proxy-main.ts emits once the proxy is actually bound + serving. */
const PROXY_LISTENING_EVENT = "listening";

export interface EnsureEgressOptions {
  /** The plan's egress decision; only the allowlist path provisions anything. */
  readonly egress: EgressDecision;
  /** In-container path to the proxy entrypoint (`proxy-main.js`). */
  readonly proxyEntrypoint: string;
  /** Image carrying a Node runtime for the proxy container. */
  readonly image?: string;
  /** Host path to the proxy's resolv.conf (external resolvers), bind-mounted in. */
  readonly resolvConfPath?: string;
  /** The external network the proxy reaches the allowlisted registries through. */
  readonly externalNetwork?: string;
  /** Inject a podman runner (tests); defaults to a real `podman` spawn. */
  readonly run?: PodmanRunner;
  /**
   * Confirm the just-started proxy is actually alive (defaults to a real probe via
   * `run`). `podman run -d` exits 0 once the container is *created*, even if its
   * process crashes a moment later — so without this a dead proxy is a silent
   * success (ADR 0005 "never silent"). Injected in tests.
   */
  readonly verifyAlive?: (run: PodmanRunner, container: string) => ProxyLiveness;
  /** Structured progress logs. */
  readonly logger?: Logger;
}

/** Whether the proxy came up, with the container output that proves/explains it. */
export interface ProxyLiveness {
  readonly alive: boolean;
  readonly detail: string;
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
  const logger = opts.logger ?? noopLogger;
  // The proxy enforces the deduped union of Build + Agent Egress (ADR 0010).
  const hosts = egressHosts(opts.egress);

  // 1. The internal network — no route off-host. Idempotent: a prior run may have
  //    left it, which is fine; only a *different* failure is fatal.
  const created = run(egressNetworkCreateArgs());
  const weCreatedNetwork = isOk(created);
  if (!weCreatedNetwork && !isAlreadyExists(created)) {
    logger.error({ network: EGRESS_NETWORK, stderr: created.stderr.trim() }, "could not create egress network");
    throw new Error(
      `dustcastle: could not create egress network ${EGRESS_NETWORK}: ${created.stderr.trim()}`,
    );
  }
  logger.info({ network: EGRESS_NETWORK }, "internal network ready");

  // 2. Clear a stale proxy from a prior run (best-effort), then start the
  //    dual-homed proxy: it alone bridges the internal net to the outside world.
  run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
  const started = run(
    proxyContainerRunArgs({
      image: opts.image ?? DEFAULT_PROXY_IMAGE,
      externalNetwork: opts.externalNetwork ?? DEFAULT_EXTERNAL_NETWORK,
      allowlist: hosts,
      proxyEntrypoint: opts.proxyEntrypoint,
      ...(opts.resolvConfPath !== undefined ? { resolvConfPath: opts.resolvConfPath } : {}),
    }),
  );
  // Fail fast, no fallback (ADR 0005/0010): scoped egress is a hard requirement —
  // the build/agent only reach the derived allowlist or nothing. dustcastle will
  // not fall back to unconfined network, so a host that can't stand up the proxy
  // must abort. Commonly the host's rootless podman can't create the proxy's
  // bridge network (needs a working netavark bridge / non-nested netns).
  const fail = (reason: string): never => {
    run(["rm", "-f", EGRESS_PROXY_CONTAINER]); // remove the dead/half-started container
    if (weCreatedNetwork) run(["network", "rm", EGRESS_NETWORK]); // roll back our own network
    logger.error({ hosts, reason }, "could not establish scoped egress proxy");
    throw new Error(
      `dustcastle: could not establish the scoped egress proxy enforcing [${hosts.join(", ")}]. ${reason}`,
    );
  };
  if (!isOk(started)) fail(`Underlying podman error: ${started.stderr.trim()}`);

  // `podman run -d` exits 0 once the container is CREATED — its process may crash a
  // moment later (e.g. the image lacks the proxy code). Confirm the proxy is truly
  // serving before declaring egress enforced; a dead proxy is never a silent success.
  const liveness = (opts.verifyAlive ?? defaultVerifyProxyAlive)(run, EGRESS_PROXY_CONTAINER);
  if (!liveness.alive) {
    fail(`The proxy container started but is not serving:\n${liveness.detail.trim()}`);
  }
  logger.info({ container: EGRESS_PROXY_CONTAINER, hosts }, "proxy enforcing allowlist");

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

export function isProxyListeningLogLine(line: string): boolean {
  try {
    const record: unknown = JSON.parse(line);
    return isObject(record) && record.event === PROXY_LISTENING_EVENT;
  } catch {
    return false;
  }
}

function proxyLogsReportListening(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim().length > 0 && isProxyListeningLogLine(line));
}

function isObject(value: unknown): value is { readonly event?: unknown } {
  return typeof value === "object" && value !== null;
}

/** How long to wait for the proxy to bind before declaring it dead (Node start is fast). */
const LIVENESS_ATTEMPTS = 20;
const LIVENESS_DELAY_MS = 150;

/**
 * Real liveness probe: poll the container's logs for the JSON `event: "listening"`
 * proxy-main.ts emits once it is serving. If the container has already exited
 * (crashed), stop early and surface its output as the failure detail. Drives off
 * the same injected `run` so it is unit-tested without real podman.
 */
function defaultVerifyProxyAlive(run: PodmanRunner, container: string): ProxyLiveness {
  let detail = "";
  for (let attempt = 0; attempt < LIVENESS_ATTEMPTS; attempt++) {
    const logs = run(["logs", container]);
    detail = `${logs.stdout ?? ""}${logs.stderr}`;
    if (proxyLogsReportListening(detail)) return { alive: true, detail };
    // Already exited? Then it will never start listening — fail now with its output.
    const inspect = run(["inspect", "-f", "{{.State.Running}}", container]);
    if ((inspect.stdout ?? "").trim() !== "true") {
      return { alive: false, detail: detail || inspect.stderr };
    }
    if (attempt < LIVENESS_ATTEMPTS - 1) sleepSync(LIVENESS_DELAY_MS);
  }
  return {
    alive: false,
    detail: `proxy did not report listening within ${LIVENESS_ATTEMPTS * LIVENESS_DELAY_MS}ms:\n${detail}`,
  };
}

/** Block the current thread for `ms` without spawning a child (Atomics-based). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** podman reports an existing network/container as "already exists" / "already in use". */
function isAlreadyExists(r: PodmanResult): boolean {
  return /already exists|already in use/i.test(r.stderr);
}

/**
 * Materialize the proxy's resolv.conf (external resolvers — see EGRESS_PROXY_DNS)
 * under the dustcastle home and return its path to bind-mount. Idempotent. Called
 * on the allowlist path before `ensureEgress`, the way the proxy image is — both
 * are proxy prerequisites the run prepares, then `ensureEgress` runs the container.
 */
export function provisionProxyResolvConf(home: string = DUSTCASTLE_HOME): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "egress-resolv.conf");
  writeFileSync(path, proxyResolvConf());
  return path;
}

function defaultPodman(args: readonly string[]): PodmanResult {
  const r = spawnSync("podman", [...args], { encoding: "utf8" });
  const stderr = r.stderr ?? (r.error instanceof Error ? r.error.message : "");
  return { status: r.status, stderr, stdout: r.stdout ?? "" };
}
