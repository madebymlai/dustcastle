import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dustcastle owns the egress-PROXY image the same way it owns the agent image
 * (ensureAgentImage) and nix-portable: a built-once, dustcastle-managed artifact
 * the production egress backend (ensureEgress) then runs by name. The stock
 * `node:20-alpine` it derives from cannot run the proxy — it has no
 * `/opt/dustcastle/proxy-main.js` — so the proxy container died on start and
 * `ensureEgress` enforced an allowlist over a *dead* proxy. This module ships the
 * proxy's (dependency-free) compiled code into the image so the container actually
 * runs. The build is a single `podman build`; mirror of agent-image.ts.
 */

/** The dustcastle-owned egress-proxy image tag (local; never pushed to a registry). */
export const PROXY_IMAGE = "localhost/dustcastle-egress-proxy:node20";

/** The minimal result of a podman invocation the build logic reasons about. */
export interface PodmanBuildResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real spawn. */
export type PodmanRunner = (args: readonly string[]) => PodmanBuildResult;

export interface EnsureProxyImageOptions {
  /** Override the image tag (tests). */
  readonly imageName?: string;
  /** Override the Containerfile path (tests); defaults to the shipped asset. */
  readonly containerfile?: string;
  /** Inject the `podman build` runner (tests); defaults to a real spawn. */
  readonly run?: PodmanRunner;
  /** Inject the "image already built?" check (tests); defaults to `podman image exists`. */
  readonly exists?: (image: string) => boolean;
  /** Surface build output line-by-line (never silent). */
  readonly onLine?: (line: string) => void;
}

/**
 * Path to the shipped Containerfile. It sits next to this module, so
 * import.meta.url resolves to src/sandbox under tsx/vitest and to dist/sandbox in
 * the built CLI (copy-assets.mjs copies it there alongside the compiled proxy). The
 * build context (its dir) therefore holds the proxy.js + proxy-main.js the COPY needs.
 */
export function proxyContainerfilePath(): string {
  return fileURLToPath(new URL("./proxy.Containerfile", import.meta.url));
}

/** The `podman build` args for the proxy image (build context = the Containerfile's dir). */
export function proxyBuildArgs(image: string, containerfile: string): string[] {
  return ["build", "-t", image, "-f", containerfile, dirname(containerfile)];
}

/**
 * Ensure the dustcastle egress-proxy image exists, building it once from the
 * shipped Containerfile if missing (idempotent: a second run is a no-op `podman
 * image exists` hit). Returns the image tag for `ensureEgress` to run. Only the
 * allowlist (impure) path ever needs it, so callers build it lazily on that path.
 */
export function ensureProxyImage(opts: EnsureProxyImageOptions = {}): string {
  const image = opts.imageName ?? PROXY_IMAGE;
  const exists = opts.exists ?? defaultImageExists;
  if (exists(image)) return image;

  const containerfile = opts.containerfile ?? proxyContainerfilePath();
  const run = opts.run ?? defaultPodmanRun(opts.onLine);
  opts.onLine?.(`egress: building the dustcastle egress-proxy image ${image} (one-time)…`);
  const result = run(proxyBuildArgs(image, containerfile));
  if (result.status !== 0) {
    throw new Error(`egress: failed to build the proxy image ${image}:\n${result.stderr.slice(-2000)}`);
  }
  opts.onLine?.(`egress: built ${image}`);
  return image;
}

/** Default check: `podman image exists <image>` exits 0 when the image is present. */
function defaultImageExists(image: string): boolean {
  return spawnSync("podman", ["image", "exists", image]).status === 0;
}

/** Default runner: a real `podman` spawn, streaming stderr to `onLine`. */
function defaultPodmanRun(onLine?: (line: string) => void): PodmanRunner {
  return (args) => {
    const r = spawnSync("podman", [...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (onLine && r.stderr) for (const line of r.stderr.split("\n")) onLine(line);
    return { status: r.status, stderr: r.stderr ?? "" };
  };
}
