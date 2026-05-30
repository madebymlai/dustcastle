import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * dustcastle owns the agent sandbox IMAGE the way it owns nix-portable
 * (ensureNixPortable): a built-once, dustcastle-managed artifact the sandcastle
 * `podman()` provider then consumes by name. We do NOT reinvent sandcastle's
 * container lifecycle, mounts, or `--userns=keep-id` mapping — we only produce the
 * image those rely on. The build is a single `podman build` (which is all
 * sandcastle's own build-image does); sandcastle's CLI build-image is coupled to a
 * project `.sandcastle/` dir, which a global tool running in arbitrary repos lacks.
 */

/** The dustcastle-owned agent image tag (local; never pushed to a registry). */
export const AGENT_IMAGE = "localhost/dustcastle-agent:bookworm";

/** The minimal result of a podman invocation the build logic reasons about. */
export interface PodmanBuildResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real spawn. */
export type PodmanRunner = (args: readonly string[]) => PodmanBuildResult;

export interface EnsureAgentImageOptions {
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
 * the built CLI (copy-assets.mjs copies it there alongside the prompts).
 */
export function agentContainerfilePath(): string {
  return fileURLToPath(new URL("./agent.Containerfile", import.meta.url));
}

/** The `podman build` args for the agent image (build context = the Containerfile's dir). */
export function agentBuildArgs(image: string, containerfile: string): string[] {
  return ["build", "-t", image, "-f", containerfile, dirname(containerfile)];
}

/**
 * Ensure the dustcastle agent image exists, building it once from the shipped
 * Containerfile if missing (idempotent: a second run is a no-op `podman image
 * exists` hit). Returns the image tag for the sandcastle provider's `imageName`.
 * The image bakes the `agent` user at uid/gid 1000 so the provider's default
 * `--userns=keep-id` maps the host user onto it — no UID build-args needed.
 */
export function ensureAgentImage(opts: EnsureAgentImageOptions = {}): string {
  const image = opts.imageName ?? AGENT_IMAGE;
  const exists = opts.exists ?? defaultImageExists;
  if (exists(image)) return image;

  const containerfile = opts.containerfile ?? agentContainerfilePath();
  const run = opts.run ?? defaultPodmanRun(opts.onLine);
  opts.onLine?.(`sandbox: building the dustcastle agent image ${image} (one-time)…`);
  const result = run(agentBuildArgs(image, containerfile));
  if (result.status !== 0) {
    throw new Error(`sandbox: failed to build the agent image ${image}:\n${result.stderr.slice(-2000)}`);
  }
  opts.onLine?.(`sandbox: built ${image}`);
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
