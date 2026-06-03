import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { noopLogger, type Logger } from "../log/index.js";
import { runStreamingAsync, type StreamingLogLevel } from "../process/streaming.js";
import { dustcastleVersion } from "../version.js";

/**
 * dustcastle owns its sandbox IMAGES the way it owns nix-portable: built-once,
 * dustcastle-managed artifacts (never pushed to a registry) that a downstream
 * consumer then runs by name. Each image is fully described by an {@link ImageSpec}
 * — a tag, a shipped Containerfile, and how to label its build output — so building
 * one is a single idempotent `podman build` over that data. The agent image
 * (consumed by sandcastle's `podman()` provider) and the egress-proxy image
 * (consumed by `ensureEgress`) are two such specs; a third would be a third spec,
 * not a third copy of this logic. We do NOT reinvent sandcastle's container
 * lifecycle, mounts, or `--userns=keep-id` mapping — we only produce the images
 * those rely on (sandcastle's own build-image is coupled to a project `.sandcastle/`
 * dir, which a global tool running in arbitrary repos lacks).
 */

/** The minimal result of a podman invocation the build logic reasons about. */
export interface PodmanBuildResult {
  readonly status: number | null;
  readonly stderr: string;
}

/** Runs a `podman <args>` command. Injected in tests; defaults to a real streaming spawn. */
export type PodmanRunner = (args: readonly string[]) => Promise<PodmanBuildResult>;

/**
 * A dustcastle-owned image, as data: everything that distinguishes one built-once
 * podman image from another. Adding an image is adding one of these, not a module.
 */
export interface ImageSpec {
  /**
   * The STABLE tag prefix (local; never pushed to a registry). The image is built
   * and run under {@link imageRef}, which appends the dustcastle version so the tag
   * busts when a release changes what the image bakes — `podman image exists` is
   * content-agnostic, so without this a proxy/agent change ships inside a release
   * but the cached image with the old tag is never rebuilt (dustcastle-q9u).
   */
  readonly tag: string;
  /** Path to the shipped Containerfile (resolved beside this module). */
  readonly containerfile: string;
  /** Human noun for the build/built/failed messages (e.g. "agent image" | "proxy image"). */
  readonly label: string;
}

export interface EnsureImageOptions {
  /** Override the image tag (tests). */
  readonly imageName?: string;
  /** Override the Containerfile path (tests); defaults to the spec's shipped asset. */
  readonly containerfile?: string;
  /** Inject the `podman build` runner (tests); defaults to a real spawn. */
  readonly run?: PodmanRunner;
  /** Inject the "image already built?" check (tests); defaults to `podman image exists`. */
  readonly exists?: (image: string) => boolean;
  /** Override the version folded into the derived tag (tests); defaults to the running version. */
  readonly version?: string;
  /** Structured logs for image build progress and podman stderr. */
  readonly logger?: Logger;
}

/**
 * Resolve a Containerfile shipped beside this module. It sits next to this module,
 * so import.meta.url resolves to src/sandbox under tsx/vitest and to dist/sandbox in
 * the built CLI (copy-assets.mjs copies the *.Containerfile there alongside the
 * loader; the proxy one's COPY then finds the compiled proxy.js + proxy-main.js
 * tsc emits into that same dir, completing a self-contained build context).
 */
export function containerfilePath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}`, import.meta.url));
}

/** The dustcastle-owned agent image, consumed by the sandcastle `podman()` provider. */
export const AGENT_SPEC: ImageSpec = {
  tag: "localhost/dustcastle-agent:bookworm",
  containerfile: containerfilePath("agent.Containerfile"),
  label: "agent image",
};

/** The dustcastle-owned egress-proxy image, run by `ensureEgress` on the allowlist path. */
export const PROXY_SPEC: ImageSpec = {
  tag: "localhost/dustcastle-egress-proxy:node20",
  containerfile: containerfilePath("proxy.Containerfile"),
  label: "proxy image",
};

/**
 * The content-busting image reference: the spec's stable tag prefix with the
 * dustcastle version appended (e.g. `…egress-proxy:node20-0.3.0`). Because the build
 * (`ensureImage`) and the run sites (plan's DEFAULT_IMAGE, egress-runtime's
 * DEFAULT_PROXY_IMAGE) all derive the ref through THIS one function, a release that
 * changes what an image bakes ships a new tag that `podman image exists` misses,
 * forcing a rebuild — and build/run can never disagree on the tag (dustcastle-q9u).
 * Version, not a content hash: the agent image installs bd/pi via unpinned network
 * fetches a local-file hash can't observe, so a per-release bump is the honest signal.
 */
export function imageRef(spec: ImageSpec, version: string = dustcastleVersion()): string {
  return `${spec.tag}-${version}`;
}

/** The `podman build` args for an image (build context = the Containerfile's dir). */
export function buildArgs(image: string, containerfile: string): string[] {
  return ["build", "-t", image, "-f", containerfile, dirname(containerfile)];
}

/**
 * Classify a podman build output line into a {@link StreamingLogLevel} for the
 * curation seam: only the `STEP x/y` progression is user-facing progress (info).
 * Cache-hit (`-->`) and `Successfully tagged` lines are detail (debug) — the
 * "built dustcastle image" log already signals success, and a fully-cached build
 * lists every historical version tag, which is pure noise. Tunable by tests.
 */
export function classifyPodmanLine(line: string): StreamingLogLevel {
  return /^STEP \d+\/\d+/i.test(line) ? "info" : "debug";
}

/**
 * Ensure a dustcastle-owned image exists, building it once from its shipped
 * Containerfile if missing (idempotent: a second run is a no-op `podman image
 * exists` hit). Returns the image tag for the consumer to run by name.
 */
export async function ensureImage(spec: ImageSpec, opts: EnsureImageOptions = {}): Promise<string> {
  const image = opts.imageName ?? imageRef(spec, opts.version ?? dustcastleVersion());
  const exists = opts.exists ?? defaultImageExists;
  if (exists(image)) return image;

  const containerfile = opts.containerfile ?? spec.containerfile;
  const logger = opts.logger ?? noopLogger;
  const run = opts.run ?? defaultPodmanRun(logger);
  logger.info({ image, label: spec.label }, "building dustcastle image");
  const result = await run(buildArgs(image, containerfile));
  if (result.status !== 0) {
    logger.error(
      { image, label: spec.label, stderr: result.stderr.slice(-2000) },
      "failed to build dustcastle image",
    );
    throw new Error(`failed to build the ${spec.label} ${image}:\n${result.stderr.slice(-2000)}`);
  }
  logger.info({ image, label: spec.label }, "built dustcastle image");
  return image;
}

/** Default check: `podman image exists <image>` exits 0 when the image is present. */
function defaultImageExists(image: string): boolean {
  return spawnSync("podman", ["image", "exists", image]).status === 0;
}

/** Default runner: a real `podman` spawn, streaming stderr live via the shared helper. */
function defaultPodmanRun(logger: Logger): PodmanRunner {
  return (args) =>
    runStreamingAsync("podman", args, {
      logger,
      label: "podman",
      classifyLine: classifyPodmanLine,
    });
}
