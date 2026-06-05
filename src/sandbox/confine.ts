import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DUSTCASTLE_HOME } from "../config/global.js";
import { ecosystemFor, packageManagerDescriptor, type PackageManager } from "../ecosystems/index.js";
import { noopLogger, type Logger } from "../log/index.js";
import { ensureImage, PROXY_SPEC } from "./image.js";

/** The internal podman network an allowlisted sandbox attaches to (production backend). */
export const EGRESS_NETWORK = "dustcastle-egress";
/** The dual-homed filtering-proxy container's name (resolvable via aardvark-dns). */
export const EGRESS_PROXY_CONTAINER = "dustcastle-egress-proxy";
/** The port the proxy listens on (both backends). */
export const EGRESS_PROXY_PORT = 8118;

/** The resolvers the production proxy container resolves allowlisted hosts through. */
const EGRESS_PROXY_DNS: readonly string[] = ["1.1.1.1", "8.8.8.8"];
/** The default in-container path the production proxy image is expected to bundle. */
const DEFAULT_PROXY_ENTRYPOINT = "/opt/dustcastle/proxy-main.js";

export type EgressDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "allowlist";
      /** Hosts the *build* needs (each detected manager's registry + git). */
      readonly buildHosts: readonly string[];
      /** The *agent's* model-provider API host(s) (ADR 0010). */
      readonly agentHosts: readonly string[];
    };

export type EgressNetworkMode = "none" | typeof EGRESS_NETWORK;

export interface EgressPosture {
  /** The podman network mode the Sandbox plan applies. */
  readonly network: EgressNetworkMode;
  /** The proxy environment the Sandbox plan applies. Empty for closed egress. */
  readonly env: Record<string, string>;
}

export interface ConfineInput {
  /** The project directory whose git remote + declared source files are scanned. */
  readonly projectDir: string;
  /** The DETECTED Package Managers; each contributes its descriptor's registry hosts. */
  readonly packageManagers: readonly PackageManager[];
  /** Agent model-provider API host(s) to allowlist alongside build egress. */
  readonly agentModelHosts?: readonly string[];
  /** Override how the Sandbox reaches the proxy (used by the gated route-strip e2e). */
  readonly proxyAddress?: string;
}

export interface EnforceConfinementOptions {
  /** The external network the proxy reaches the allowlisted registries through. */
  readonly externalNetwork?: string;
  /** Inject a podman runner (tests); defaults to a real `podman` spawn. */
  readonly run?: PodmanRunner;
  /** Inject liveness verification (tests); defaults to podman-log polling. */
  readonly verifyAlive?: (run: PodmanRunner, container: string) => ProxyLiveness;
  /** Inject image provisioning (tests); production builds the dustcastle proxy image. */
  readonly ensureProxyImage?: (logger: Logger) => Promise<string>;
  /** Override dustcastle's home for materializing proxy prerequisites (tests). */
  readonly dustcastleHome?: string;
  /** Structured progress logs. */
  readonly logger?: Logger;
}

export interface Confinement {
  /** The allowlist decision, surfaced for never-silent banners and assertions. */
  readonly decision: EgressDecision;
  /** The network/env posture the Sandbox plan drops into podman options. */
  readonly posture: EgressPosture;
  /** Bring up the production confinement backend, resolving to its teardown handle. */
  enforce(opts?: EnforceConfinementOptions): Promise<EgressHandle>;
}

/**
 * The single Egress facade (ADR 0005/0010/0012): derive the standing allowlist,
 * resolve the proxy address once, expose the plan posture, and wrap the production
 * backend bring-up (proxy image → resolv.conf → internal network → live proxy).
 * The Sandbox plan consumes only `posture` and never re-derives or branches on
 * Egress internals.
 */
export function confine(input: ConfineInput): Confinement {
  const remoteHost = gitRemoteHost(input.projectDir);
  const decision = deriveEgress({
    packageManagers: input.packageManagers,
    projectDir: input.projectDir,
    ...(remoteHost !== undefined ? { gitRemoteHost: remoteHost } : {}),
    ...(input.agentModelHosts !== undefined ? { agentModelHosts: input.agentModelHosts } : {}),
  });
  const proxyAddress = input.proxyAddress ?? productionProxyUrl();
  return {
    decision,
    posture: postureFor(decision, proxyAddress),
    enforce: (opts = {}) => ensureEgress({ egress: decision, ...opts }),
  };
}

interface EgressInput {
  readonly packageManagers: readonly PackageManager[];
  readonly gitRemoteHost?: string;
  readonly projectDir?: string;
  readonly agentModelHosts?: readonly string[];
}

function deriveEgress(input: EgressInput): EgressDecision {
  const buildHosts = buildEgressHosts(input);
  const agentHosts = (input.agentModelHosts ?? []).filter((host) => host.length > 0);

  if (buildHosts.length === 0 && agentHosts.length === 0) return { kind: "none" };
  return { kind: "allowlist", buildHosts, agentHosts };
}

function postureFor(decision: EgressDecision, proxyAddress: string): EgressPosture {
  if (decision.kind === "none") return { network: "none", env: {} };
  return { network: EGRESS_NETWORK, env: proxyEnv(proxyAddress) };
}

function buildEgressHosts(input: EgressInput): string[] {
  const hosts = input.packageManagers.flatMap((pm) => packageManagerDescriptor(pm).registryHosts);
  if (input.projectDir !== undefined) {
    for (const pm of input.packageManagers) hosts.push(...gitDepHosts(input.projectDir, pm));
  }
  const gitRemoteHost = input.gitRemoteHost;
  if (gitRemoteHost !== undefined && gitRemoteHost.length > 0) hosts.push(gitRemoteHost);
  return uniqueHosts(hosts);
}

function gitDepHosts(projectDir: string, pm: PackageManager): string[] {
  const descriptor = packageManagerDescriptor(pm);
  const files = [...ecosystemFor(descriptor.ecosystem).manifests, ...descriptor.lockfiles];
  const hosts = new Set<string>();
  for (const name of files) {
    let text: string;
    try {
      text = readFileSync(join(projectDir, name), "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/(?:git\+[a-z0-9]+:\/\/|git:\/\/|ssh:\/\/|git@)[^\s"'`,)\]}<>]+/gi)) {
      const host = parseGitRemoteHost(match[0].replace(/^git\+/i, ""));
      if (host !== undefined && host.length > 0) hosts.add(host);
    }
    for (const match of text.matchAll(/\b(github|gitlab|bitbucket):[\w.-]+\/[\w.-]+/gi)) {
      const forge = match[1];
      if (forge !== undefined) hosts.add(forgeHost(forge));
    }
  }
  return [...hosts];
}

/** The deduped flat allowlist the filtering proxy enforces. */
export function egressHosts(decision: EgressDecision): string[] {
  if (decision.kind === "none") return [];
  return uniqueHosts([...decision.buildHosts, ...decision.agentHosts]);
}

const SCP_STYLE_GIT_REMOTE = /^(?:[^@/]+@)?([^/:]+):/;

/** Extract the host from a git remote URL — scp-style, ssh://, https://, etc. */
export function parseGitRemoteHost(remoteUrl: string): string | undefined {
  const url = remoteUrl.trim();
  if (url.length === 0) return undefined;

  const scpHost = SCP_STYLE_GIT_REMOTE.exec(url)?.[1];
  if (scpHost !== undefined && !url.includes("://")) return scpHost;

  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function gitRemoteHost(cwd: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return parseGitRemoteHost(result.stdout.trim());
}

function forgeHost(forge: string): string {
  switch (forge.toLowerCase()) {
    case "github":
      return "github.com";
    case "gitlab":
      return "gitlab.com";
    case "bitbucket":
      return "bitbucket.org";
    default:
      throw new Error(`unsupported git forge shorthand: ${forge}`);
  }
}

function uniqueHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}

/** Point a build's HTTP tooling (and npm) at the egress proxy. */
function proxyEnv(proxyUrl: string): Record<string, string> {
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
function productionProxyUrl(): string {
  return `http://${EGRESS_PROXY_CONTAINER}:${EGRESS_PROXY_PORT}`;
}

/** The /etc/resolv.conf body the proxy container mounts (external resolvers only). */
function proxyResolvConf(servers: readonly string[] = EGRESS_PROXY_DNS): string {
  return servers.map((s) => `nameserver ${s}`).join("\n") + "\n";
}

function egressNetworkCreateArgs(network: string = EGRESS_NETWORK): string[] {
  return ["network", "create", "--internal", network];
}

interface ProxyContainerSpec {
  readonly image: string;
  readonly externalNetwork: string;
  readonly allowlist: readonly string[];
  readonly proxyEntrypoint: string;
  readonly resolvConfPath?: string;
  readonly container?: string;
  readonly network?: string;
  readonly port?: number;
}

function proxyContainerRunArgs(spec: ProxyContainerSpec): string[] {
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
    ...(spec.resolvConfPath ? ["-v", `${spec.resolvConfPath}:/etc/resolv.conf:ro`] : []),
    "-e",
    `DUSTCASTLE_EGRESS_ALLOWLIST=${spec.allowlist.join(",")}`,
    "-e",
    `DUSTCASTLE_EGRESS_PORT=${port}`,
    "-e",
    "DUSTCASTLE_EGRESS_HOST=0.0.0.0",
    spec.image,
    "node",
    spec.proxyEntrypoint,
  ];
}

export interface ConfineRouteOptions {
  /** The proxy port to keep reachable (kept for symmetry; a /32 route covers any port). */
  readonly proxyPort?: number;
}

/** The privilege-stripped-host route-strip helper used by the gated e2e. */
export function confineRouteScript(proxyAddr: string, _opts: ConfineRouteOptions = {}): string {
  return [
    "set -e",
    'DEV=$(ip route | awk "/default/ {print \\$5; exit}")',
    `ip route add ${proxyAddr}/32 dev "$DEV"`,
    "ip route del default",
  ].join("\n");
}

/** The minimal result of a podman invocation the orchestration reasons about. */
export interface PodmanResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout?: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real spawn. */
export type PodmanRunner = (args: readonly string[]) => PodmanResult;

const DEFAULT_EXTERNAL_NETWORK = "podman";
const PROXY_LISTENING_EVENT = "listening";

/** Whether the proxy came up, with the container output that proves/explains it. */
export interface ProxyLiveness {
  readonly alive: boolean;
  readonly detail: string;
}

/** A handle to the live egress infra. */
export interface EgressHandle {
  /** Idempotent, best-effort teardown of the proxy container + network. */
  readonly teardown: () => void;
}

const NOOP: EgressHandle = { teardown: () => {} };

interface EnsureEgressOptions extends EnforceConfinementOptions {
  readonly egress: EgressDecision;
}

async function ensureEgress(opts: EnsureEgressOptions): Promise<EgressHandle> {
  if (opts.egress.kind !== "allowlist") return NOOP;
  const run = opts.run ?? defaultPodman;
  const logger = opts.logger ?? noopLogger;
  const hosts = egressHosts(opts.egress);

  const image = await (opts.ensureProxyImage ?? defaultEnsureProxyImage)(logger);
  const resolvConfPath = provisionProxyResolvConf(opts.dustcastleHome);

  const created = run(egressNetworkCreateArgs());
  const weCreatedNetwork = isOk(created);
  if (!weCreatedNetwork && !isAlreadyExists(created)) {
    logger.error({ network: EGRESS_NETWORK, stderr: created.stderr.trim() }, "could not create egress network");
    throw new Error(`dustcastle: could not create egress network ${EGRESS_NETWORK}: ${created.stderr.trim()}`);
  }
  logger.info({ network: EGRESS_NETWORK }, "internal network ready");

  run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
  const started = run(
    proxyContainerRunArgs({
      image,
      externalNetwork: opts.externalNetwork ?? DEFAULT_EXTERNAL_NETWORK,
      allowlist: hosts,
      proxyEntrypoint: DEFAULT_PROXY_ENTRYPOINT,
      resolvConfPath,
    }),
  );

  const fail = (reason: string): never => {
    run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
    if (weCreatedNetwork) run(["network", "rm", EGRESS_NETWORK]);
    logger.error({ hosts: hosts.join(", "), reason }, "could not establish scoped egress proxy");
    throw new Error(`dustcastle: could not establish the scoped egress proxy enforcing [${hosts.join(", ")}]. ${reason}`);
  };
  if (!isOk(started)) fail(`Underlying podman error: ${started.stderr.trim()}`);

  const liveness = (opts.verifyAlive ?? defaultVerifyProxyAlive)(run, EGRESS_PROXY_CONTAINER);
  if (!liveness.alive) fail(`The proxy container started but is not serving:\n${liveness.detail.trim()}`);

  logger.info({ container: EGRESS_PROXY_CONTAINER, hosts: hosts.join(", ") }, "proxy enforcing allowlist");
  return {
    teardown: () => {
      run(["rm", "-f", EGRESS_PROXY_CONTAINER]);
      run(["network", "rm", EGRESS_NETWORK]);
    },
  };
}

function isOk(r: PodmanResult): boolean {
  return r.status === 0;
}

interface ProxyLogRecord {
  readonly event?: unknown;
}

export function isProxyListeningLogLine(line: string): boolean {
  return parseProxyLogLine(line)?.event === PROXY_LISTENING_EVENT;
}

function parseProxyLogLine(line: string): ProxyLogRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isProxyLogRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isProxyLogRecord(value: unknown): value is ProxyLogRecord {
  return typeof value === "object" && value !== null;
}

function proxyLogsReportListening(output: string): boolean {
  return output.split(/\r?\n/).some(isProxyListeningLogLine);
}

const LIVENESS_ATTEMPTS = 20;
const LIVENESS_DELAY_MS = 150;

function defaultVerifyProxyAlive(run: PodmanRunner, container: string): ProxyLiveness {
  let detail = "";
  for (let attempt = 0; attempt < LIVENESS_ATTEMPTS; attempt++) {
    const logs = run(["logs", container]);
    detail = `${logs.stdout ?? ""}${logs.stderr}`;
    if (proxyLogsReportListening(detail)) return { alive: true, detail };
    const inspect = run(["inspect", "-f", "{{.State.Running}}", container]);
    if ((inspect.stdout ?? "").trim() !== "true") return { alive: false, detail: detail || inspect.stderr };
    if (attempt < LIVENESS_ATTEMPTS - 1) sleepSync(LIVENESS_DELAY_MS);
  }
  return {
    alive: false,
    detail: `proxy did not report listening within ${LIVENESS_ATTEMPTS * LIVENESS_DELAY_MS}ms:\n${detail}`,
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlreadyExists(r: PodmanResult): boolean {
  return /already exists|already in use/i.test(r.stderr);
}

/** Materialize the proxy's external-resolver resolv.conf under the dustcastle home. */
function provisionProxyResolvConf(home: string = DUSTCASTLE_HOME): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, "egress-resolv.conf");
  writeFileSync(path, proxyResolvConf());
  return path;
}

function defaultEnsureProxyImage(logger: Logger): Promise<string> {
  return ensureImage(PROXY_SPEC, { logger });
}

function defaultPodman(args: readonly string[]): PodmanResult {
  const r = spawnSync("podman", [...args], { encoding: "utf8" });
  const stderr = r.stderr ?? (r.error instanceof Error ? r.error.message : "");
  return { status: r.status, stderr, stdout: r.stdout ?? "" };
}
